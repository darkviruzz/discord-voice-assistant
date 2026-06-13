/* Live-transcript web UI — vanilla JS, no build step, no dependencies.
 *
 * Flow:
 *   1. Load the session list, fill the picker, pick the URL/?sessionId or newest.
 *   2. Open an EventSource to /transcript/live; render the `snapshot` (full
 *      history from the JSONL) then append each live `entry`.
 *   3. If SSE is unavailable or keeps failing, fall back to JSON polling of
 *      /transcript/snapshot/:id.
 *
 * Read-only: no user input is ever sent back to the server.
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    status: $('#status'),
    select: $('#session-select'),
    debug: $('#debug-toggle'),
    transcript: $('#transcript'),
    emptyHint: $('#empty-hint'),
    summaryBox: $('#summary-box'),
    summaryText: $('#summary-text'),
    jump: $('#jump-latest'),
  };

  const params = new URLSearchParams(location.search);
  const state = {
    sessionId: params.get('sessionId') || null,
    debug: params.get('debug') === '1',
    es: null,            // EventSource
    pollTimer: null,     // polling fallback interval
    sseFailures: 0,
    lastStartMs: -Infinity, // newest rendered entry time (dedupe across reconnect/poll)
    atBottom: true,
  };

  // ── tiny, XSS-safe markdown renderer ───────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  // Inline: code, bold, italic, autolinked http(s) URLs. Operates on already
  // HTML-escaped text, and only ever emits our own tags → safe.
  function inlineMd(s) {
    let out = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`);
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, c) => `${p}<em>${c}</em>`);
    out = out.replace(/(^|[^_])_([^_\n]+)_/g, (_m, p, c) => `${p}<em>${c}</em>`);
    out = out.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    return out;
  }

  // Block-level: headings, unordered/ordered lists, blockquotes, paragraphs.
  function renderMarkdown(text) {
    const lines = escapeHtml(String(text)).split(/\r?\n/);
    const html = [];
    let list = null; // 'ul' | 'ol' | null
    const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) { closeList(); continue; }

      let m;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        closeList();
        html.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`);
      } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
        if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
        html.push(`<li>${inlineMd(m[1])}</li>`);
      } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
        if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
        html.push(`<li>${inlineMd(m[1])}</li>`);
      } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        closeList();
        html.push(`<blockquote>${inlineMd(m[1])}</blockquote>`);
      } else {
        closeList();
        html.push(`<p>${inlineMd(line)}</p>`);
      }
    }
    closeList();
    return html.join('');
  }

  // ── speaker colors ──────────────────────────────────────────────────────────
  function hueFor(label) {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function speakerColor(label) {
    return `hsl(${hueFor(label)}, var(--speaker-sat), var(--speaker-light))`;
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function entryEl(entry) {
    const wrap = document.createElement('article');
    wrap.className = 'entry' + (entry.kind === 'assistant' ? ' entry--assistant' : '');

    const meta = document.createElement('div');
    meta.className = 'entry-meta';

    const speaker = document.createElement('span');
    speaker.className = 'entry-speaker';
    if (entry.kind !== 'assistant') speaker.style.color = speakerColor(entry.label || '?');
    speaker.textContent = entry.label || '?';
    meta.appendChild(speaker);

    if (state.debug) {
      const time = document.createElement('span');
      time.className = 'entry-time';
      time.textContent = `${fmtTime(entry.startMs)} · ${entry.startMs}`;
      meta.appendChild(time);

      const kind = document.createElement('span');
      kind.className = 'entry-kind';
      kind.textContent = entry.kind;
      meta.appendChild(kind);

      const nsp = entry.meta && entry.meta.noSpeechProb;
      if (nsp != null) {
        const n = document.createElement('span');
        n.className = 'entry-nsp' + (nsp >= 0.5 ? ' high' : '');
        n.textContent = `no_speech ${Number(nsp).toFixed(2)}`;
        meta.appendChild(n);
      }
    } else {
      const time = document.createElement('span');
      time.className = 'entry-time';
      time.textContent = fmtTime(entry.startMs);
      meta.appendChild(time);
    }

    const body = document.createElement('div');
    body.className = 'entry-body';
    body.innerHTML = renderMarkdown(entry.text || '');

    wrap.appendChild(meta);
    wrap.appendChild(body);
    return wrap;
  }

  function clearTranscript() {
    els.transcript.innerHTML = '';
    state.lastStartMs = -Infinity;
  }

  function appendEntry(entry) {
    if (entry.startMs <= state.lastStartMs && state.lastStartMs !== -Infinity) {
      // Already shown (snapshot/poll overlap) — skip unless it's a brand-new ms.
      if (entry.startMs < state.lastStartMs) return;
    }
    if (els.emptyHint && els.emptyHint.parentNode) els.emptyHint.remove();
    els.transcript.appendChild(entryEl(entry));
    state.lastStartMs = Math.max(state.lastStartMs, entry.startMs);
    if (state.atBottom) scrollToBottom();
    else els.jump.hidden = false;
  }

  function renderSnapshot(snap) {
    clearTranscript();
    if (snap.summary && snap.summary.trim()) {
      els.summaryText.textContent = snap.summary;
      els.summaryBox.hidden = false;
    } else {
      els.summaryBox.hidden = true;
    }
    if (!snap.entries || snap.entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Noch nichts transkribiert.';
      els.transcript.appendChild(p);
      return;
    }
    for (const e of snap.entries) {
      els.transcript.appendChild(entryEl(e));
      state.lastStartMs = Math.max(state.lastStartMs, e.startMs);
    }
    scrollToBottom();
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight });
    els.jump.hidden = true;
  }

  // ── status ──────────────────────────────────────────────────────────────────
  function setStatus(kind, text) {
    els.status.className = `status status--${kind}`;
    els.status.innerHTML = `●&nbsp;${text}`;
  }

  // ── transport: SSE primary ──────────────────────────────────────────────────
  // Resolve API paths relative to where index.html is served (/transcript/),
  // so the UI keeps working if the route is ever mounted elsewhere.
  function baseUrl() {
    return location.pathname.replace(/\/[^/]*$/, '');
  }
  function liveUrl() {
    const q = state.sessionId ? `?sessionId=${encodeURIComponent(state.sessionId)}` : '';
    return `${baseUrl()}/live${q}`;
  }

  function stopTransport() {
    if (state.es) { state.es.close(); state.es = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function startSse() {
    stopTransport();
    setStatus('connecting', 'verbinde…');
    let es;
    try {
      es = new EventSource(liveUrl());
    } catch {
      startPolling();
      return;
    }
    state.es = es;

    es.addEventListener('snapshot', (ev) => {
      state.sseFailures = 0;
      setStatus('live', 'live (SSE)');
      try { renderSnapshot(JSON.parse(ev.data)); } catch {}
    });
    es.addEventListener('entry', (ev) => {
      try { appendEntry(JSON.parse(ev.data)); } catch {}
    });
    es.addEventListener('error', (ev) => {
      // Custom server 'error' event carries data; transport errors do not.
      if (ev && ev.data) { try { console.warn('transcript:', JSON.parse(ev.data)); } catch {} }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; surface the gap and fall back after a while.
      state.sseFailures++;
      if (es.readyState === EventSource.CLOSED || state.sseFailures >= 4) {
        setStatus('error', 'SSE getrennt → Polling');
        startPolling();
      } else {
        setStatus('connecting', 'reconnect…');
      }
    };
  }

  // ── transport: polling fallback ──────────────────────────────────────────────
  async function pollOnce() {
    if (!state.sessionId) return;
    try {
      const res = await fetch(`${baseUrl()}/snapshot/${encodeURIComponent(state.sessionId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      setStatus('polling', 'live (Polling)');
      renderSnapshot(snap);
    } catch (e) {
      setStatus('error', 'Polling fehlgeschlagen');
    }
  }
  function startPolling() {
    stopTransport();
    setStatus('polling', 'Polling…');
    pollOnce();
    state.pollTimer = setInterval(pollOnce, 3000);
  }

  // ── session picker ────────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      const res = await fetch(`${baseUrl()}/sessions`, { cache: 'no-store' });
      const data = await res.json();
      const list = (data && data.sessions) || [];
      els.select.innerHTML = '';
      if (list.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(keine aktive Session)';
        els.select.appendChild(opt);
      }
      for (const s of list) {
        const opt = document.createElement('option');
        opt.value = s.sessionId;
        const where = [s.guildName, s.channelName].filter(Boolean).join(' / ');
        opt.textContent = where ? `${where} — ${s.sessionId}` : s.sessionId;
        els.select.appendChild(opt);
      }
      if (!state.sessionId && list.length) state.sessionId = list[0].sessionId; // newest first
      if (state.sessionId) els.select.value = state.sessionId;
    } catch {
      /* picker stays empty; live endpoint still auto-detects newest */
    }
  }

  // ── URL sync ────────────────────────────────────────────────────────────────
  function syncUrl() {
    const p = new URLSearchParams();
    if (state.sessionId) p.set('sessionId', state.sessionId);
    if (state.debug) p.set('debug', '1');
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  // ── wiring ──────────────────────────────────────────────────────────────────
  els.debug.checked = state.debug;
  document.body.classList.toggle('debug', state.debug);
  els.debug.addEventListener('change', () => {
    state.debug = els.debug.checked;
    document.body.classList.toggle('debug', state.debug);
    syncUrl();
    startSse(); // re-render with/without debug fields via a fresh snapshot
  });

  els.select.addEventListener('change', () => {
    state.sessionId = els.select.value || null;
    syncUrl();
    startSse();
  });

  els.jump.addEventListener('click', () => { state.atBottom = true; scrollToBottom(); });

  // Track whether the user is pinned to the bottom (auto-scroll) or scrolled up.
  window.addEventListener('scroll', () => {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    state.atBottom = nearBottom;
    if (nearBottom) els.jump.hidden = true;
  }, { passive: true });

  (async function init() {
    await loadSessions();
    syncUrl();
    if (typeof EventSource !== 'undefined') startSse();
    else startPolling();
  })();
})();
