/* Live-transcript web UI — vanilla JS, no build step, no dependencies.
 *
 * Flow:
 *   1. Load the session list, fill the picker, pick the URL/?sessionId or newest.
 *   2. Open an EventSource to /transcript/live; render the `snapshot` (full
 *      history from the JSONL) then append each live `entry`. `presence` updates
 *      the voice pill/members; `annotation` retro-marks a line (wake/stop).
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
    voice: $('#voice'),
    select: $('#session-select'),
    debug: $('#debug-toggle'),
    past: $('#past-toggle'),
    transcript: $('#transcript'),
    emptyHint: $('#empty-hint'),
    summaryBox: $('#summary-box'),
    summaryText: $('#summary-text'),
    membersPop: $('#members-pop'),
    membersCount: $('#members-count'),
    membersList: $('#members-list'),
    sessionMeta: $('#session-meta'),
    sessionMetaBody: $('#session-meta-body'),
    jump: $('#jump-latest'),
  };

  const params = new URLSearchParams(location.search);
  const state = {
    sessionId: params.get('sessionId') || null,
    debug: params.get('debug') === '1',
    showPast: false,
    es: null,            // EventSource
    pollTimer: null,     // polling fallback interval
    sseFailures: 0,
    lastStartMs: -Infinity, // newest rendered entry time (dedupe across reconnect/poll)
    atBottom: true,
    rendered: new Map(), // startMs → { data, el } so annotations can patch a line
    stopPhrases: [],     // from session_meta, for stop-token highlighting
    wakeWord: 'Rabenauge',
  };

  // ── tiny, XSS-safe markdown renderer ───────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
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
    const lines = escapeHtml(text).split(/\r?\n/);
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

  // Locate the first stop-phrase occurrence in `text` (case-insensitive). Stop
  // commands are short, so a plain earliest-substring scan is enough.
  function findStopToken(text, phrases) {
    const hay = text.toLowerCase();
    let best = null;
    for (const p of phrases) {
      const needle = String(p).toLowerCase().trim();
      if (!needle) continue;
      const i = hay.indexOf(needle);
      if (i >= 0 && (!best || i < best.index)) best = { index: i, length: needle.length };
    }
    return best;
  }

  // Small tag shown before each raw chunk in debug mode. natural-silence chunks
  // end a sentence-ish group (may break); forced ones were joined seamlessly.
  function chunkSplitTag(split) {
    if (!split) return '';
    const s = String(split);
    const cls = s.indexOf('natural') === 0 ? 'chunk--natural'
      : s.indexOf('forced') === 0 ? 'chunk--forced' : 'chunk--other';
    return `<span class="chunk-split ${cls}">${escapeHtml(s)}</span>`;
  }

  // One paragraph of HTML per raw whisper chunk (debug) or natural-silence group.
  const chunkPart = (c) => `<p class="chunk">${chunkSplitTag(c.split)}${inlineMd(escapeHtml(c.text || ''))}</p>`;
  const segmentPart = (s) => `<p>${inlineMd(escapeHtml(String(s)))}</p>`;

  // Paragraph-HTML array for a streamed user entry, or null when this entry
  // isn't the segment/chunk kind (assistant markdown, stop-line, plain text).
  // Returning an array lets the live updater patch append-only (finalized
  // paragraphs stay put; only new ones fade in) — cf. interim/final results in
  // streaming ASR: finals are stable and never jump/disappear.
  function userParts(entry) {
    if (entry.stopDetected && state.stopPhrases.length) return null;
    if (state.debug && Array.isArray(entry.chunks) && entry.chunks.length) return entry.chunks.map(chunkPart);
    if (Array.isArray(entry.segments) && entry.segments.length) {
      return entry.segments.map((s) => String(s || '')).filter((s) => s.trim()).map(segmentPart);
    }
    return null;
  }

  // Body HTML for an entry: full markdown, except stop lines render the matched
  // stop token in a <mark> (rest as plain escaped text — stop commands are tiny).
  function renderBody(entry) {
    if (entry.stopDetected && state.stopPhrases.length) {
      const tok = findStopToken(entry.text || '', state.stopPhrases);
      if (tok) {
        const t = entry.text;
        return `${escapeHtml(t.slice(0, tok.index))}`
          + `<mark class="stop-token">${escapeHtml(t.slice(tok.index, tok.index + tok.length))}</mark>`
          + `${escapeHtml(t.slice(tok.index + tok.length))}`;
      }
    }
    const parts = userParts(entry);
    if (parts) return parts.join('');
    return renderMarkdown(entry.text || '');
  }

  function htmlToEl(html) {
    const t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstChild;
  }

  // Build a paragraph element, tagging it with its source HTML so later diffs
  // compare against the logical content (ignoring the transient para-enter class).
  function makePart(html) {
    const el = htmlToEl(html);
    el._src = html;
    return el;
  }

  // ── colors / time formatting ────────────────────────────────────────────────
  function hueFor(label) {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function speakerColor(label) {
    return `hsl(${hueFor(label)}, var(--speaker-sat), var(--speaker-light))`;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad3(n) { return String(n).padStart(3, '0'); }
  // hh:mm:ss, or hh:mm:ss.mmm with millisecond precision (debug).
  function fmtTime(ms, withMs = false) {
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '';
    const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    return withMs ? `${base}.${pad3(d.getMilliseconds())}` : base;
  }
  // Human-readable session timestamp from the epoch-ms session id.
  function fmtDateTime(ms) {
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return String(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // ── entry rendering ───────────────────────────────────────────────────────
  function entryEl(entry) {
    const wrap = document.createElement('article');
    wrap.className = 'entry'
      + (entry.kind === 'assistant' ? ' entry--assistant' : '')
      + (entry.wakeDetected ? ' entry--wake' : '')
      + (entry.stopDetected ? ' entry--stop' : '');

    const meta = document.createElement('div');
    meta.className = 'entry-meta';

    const speaker = document.createElement('span');
    speaker.className = 'entry-speaker';
    if (entry.kind !== 'assistant') speaker.style.color = speakerColor(entry.label || '?');
    speaker.textContent = entry.label || '?';
    meta.appendChild(speaker);

    if (entry.wakeDetected) meta.appendChild(badge('→ ' + state.wakeWord, 'badge-wake'));
    if (entry.stopDetected) meta.appendChild(badge('Stop', 'badge-stop'));
    if (state.debug && entry.marker) meta.appendChild(badge(entry.marker, 'badge-marker'));

    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = fmtTime(entry.startMs, state.debug); // hh:mm:ss.mmm in debug
    meta.appendChild(time);

    if (state.debug) {
      const kind = document.createElement('span');
      kind.className = 'entry-kind';
      kind.textContent = entry.kind;
      meta.appendChild(kind);
    }

    const body = document.createElement('div');
    body.className = 'entry-body';
    body.innerHTML = renderBody(entry);

    wrap.appendChild(meta);
    wrap.appendChild(body);

    if (state.debug) {
      const dbg = debugDetail(entry);
      if (dbg) wrap.appendChild(dbg);
    }
    return wrap;
  }

  function badge(text, cls) {
    const b = document.createElement('span');
    b.className = `badge ${cls}`;
    b.textContent = text;
    return b;
  }

  // Debug footer for an entry: STT diagnostics (user) or TTS/turn info (assistant).
  function debugDetail(entry) {
    const bits = [];
    if (entry.kind === 'user' && entry.stt) {
      const s = entry.stt;
      if (s.noSpeechProb != null) bits.push(`no_speech ${Number(s.noSpeechProb).toFixed(2)}`);
      if (s.durationMs != null) bits.push(`${Math.round(s.durationMs)}ms`);
      if (s.wordCount != null) bits.push(`${s.wordCount} W`);
      if (s.provider) bits.push(s.provider);
      if (Array.isArray(s.chunkDurationsMs) && s.chunkDurationsMs.length > 1) bits.push(`chunks ${s.chunkDurationsMs.length}`);
      if (Array.isArray(s.splitTypes) && s.splitTypes.length) bits.push(s.splitTypes.join('/'));
    } else if (entry.kind === 'assistant' && entry.turn) {
      const t = entry.turn;
      if (t.ttsStatus) bits.push(`tts:${t.ttsStatus}${t.ttsError ? ` (${t.ttsError})` : ''}`);
      if (t.ttsDurationMs != null) bits.push(`${Math.round(t.ttsDurationMs)}ms`);
      if (t.ttsModel) bits.push(t.ttsModel);
      if (t.speakerId != null) bits.push(`spk ${t.speakerId}`);
      if (t.truncated) bits.push('abgebrochen');
      for (const it of (t.interruptions || [])) {
        bits.push(`⏸ ${it.by || '?'}${it.msPlayed != null ? ` @${Math.round(it.msPlayed)}ms` : ''}`);
      }
    }
    if (entry.kind === 'assistant' && entry.interrupted && !(entry.turn && entry.turn.truncated)) bits.push('abgebrochen');
    if (!bits.length) return null;
    const d = document.createElement('div');
    d.className = 'entry-debug';
    d.textContent = bits.join(' · ');
    return d;
  }

  function clearTranscript() {
    els.transcript.innerHTML = '';
    state.lastStartMs = -Infinity;
    state.rendered.clear();
  }

  function pushEntry(entry, { scroll }) {
    if (els.emptyHint && els.emptyHint.parentNode) els.emptyHint.remove();
    const el = entryEl(entry);
    els.transcript.appendChild(el);
    state.rendered.set(entry.startMs, { data: entry, el });
    state.lastStartMs = Math.max(state.lastStartMs, entry.startMs);
    if (scroll) {
      if (state.atBottom) scrollToBottom();
      else els.jump.hidden = false;
    }
  }

  // Insert a new entry, or update an existing one in place (same startMs). Live
  // streaming publishes an utterance repeatedly as chunks arrive.
  function upsertEntry(entry) {
    const rec = state.rendered.get(entry.startMs);
    if (rec) {
      const parts = entry.kind === 'user' ? userParts(entry) : null;
      if (parts) patchEntry(rec, entry, parts);       // smooth, append-only
      else { rec.data = entry; const fresh = entryEl(entry); rec.el.replaceWith(fresh); rec.el = fresh; }
      if (state.atBottom) scrollToBottom();
      return;
    }
    if (entry.startMs < state.lastStartMs && state.lastStartMs !== -Infinity) return; // out of order, older
    pushEntry(entry, { scroll: true });
  }

  // Append-only paragraph patch: keep already-rendered paragraphs stable, update
  // changed ones in place, fade in new ones. Never removes paragraphs during a
  // partial (finalized text must not disappear); reconciles length + adds the
  // debug footer only on the final (partial=false) update.
  function patchEntry(rec, entry, parts) {
    rec.data = entry;
    const bodyEl = rec.el.querySelector('.entry-body');
    if (!bodyEl) { const fresh = entryEl(entry); rec.el.replaceWith(fresh); rec.el = fresh; return; }

    const existing = Array.from(bodyEl.children);
    for (let i = 0; i < parts.length; i++) {
      if (i < existing.length) {
        const cur = existing[i]._src ?? existing[i].outerHTML;
        if (cur !== parts[i]) bodyEl.replaceChild(makePart(parts[i]), existing[i]);
      } else {
        const el = makePart(parts[i]);
        el.classList.add('para-enter'); // fade/slide-in (the "ease")
        bodyEl.appendChild(el);
      }
    }
    if (!entry.partial) {
      // Final: drop any surplus paragraphs (normally none — updates are monotonic)
      // and sync the debug footer.
      for (let i = bodyEl.children.length - 1; i >= parts.length; i--) bodyEl.children[i].remove();
      const dbg = state.debug ? debugDetail(entry) : null;
      const oldDbg = rec.el.querySelector('.entry-debug');
      if (oldDbg && dbg) oldDbg.replaceWith(dbg);
      else if (oldDbg && !dbg) oldDbg.remove();
      else if (dbg) rec.el.appendChild(dbg);
    }
  }

  // Retro-mark a line by startMs (wake/stop detected after it was sent).
  function applyAnnotation(ann) {
    if (!ann || ann.startMs == null) return;
    const rec = state.rendered.get(ann.startMs);
    if (!rec) return;
    if (ann.wakeDetected) rec.data.wakeDetected = true;
    if (ann.stopDetected) rec.data.stopDetected = true;
    const fresh = entryEl(rec.data);
    rec.el.replaceWith(fresh);
    rec.el = fresh;
  }

  function renderSnapshot(snap) {
    clearTranscript();
    state.stopPhrases = (snap.sessionMeta && snap.sessionMeta.stopPhrases) || [];
    state.wakeWord = (snap.sessionMeta && snap.sessionMeta.wakeword && snap.sessionMeta.wakeword.word) || 'Rabenauge';
    renderVoice(snap.voice);
    renderSessionMeta(snap);

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
    for (const e of snap.entries) pushEntry(e, { scroll: false });
    scrollToBottom();
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight });
    els.jump.hidden = true;
  }

  // ── status (data transport: SSE / polling) ──────────────────────────────────
  function setStatus(kind, text) {
    els.status.className = `status status--${kind}`;
    els.status.innerHTML = `●&nbsp;${text}`;
  }

  // ── voice-channel / bot presence (header pill + members popover) ─────────────
  function renderVoice(voice) {
    if (!voice) {
      els.voice.className = 'voice voice--unknown';
      els.voice.textContent = '🎙 unbekannt';
      els.membersPop.hidden = true;
      return;
    }
    const n = (voice.members || []).length;
    if (voice.populated) {
      els.voice.className = 'voice voice--connected';
      els.voice.textContent = `🎙 Rabenauge verbunden · ${n} im Channel`;
    } else if (voice.connected) {
      els.voice.className = 'voice voice--alone';
      els.voice.textContent = '🎙 Rabenauge verbunden · allein';
    } else {
      els.voice.className = 'voice voice--offline';
      els.voice.textContent = '🎙 Rabenauge nicht verbunden';
    }

    els.membersList.innerHTML = '';
    els.membersCount.textContent = String(n);
    els.membersPop.hidden = n === 0;
    for (const m of voice.members) {
      const li = document.createElement('li');
      li.textContent = m.label || '?';
      li.style.color = speakerColor(m.label || '?');
      els.membersList.appendChild(li);
    }
  }

  // ── debug-only session-meta header ──────────────────────────────────────────
  function renderSessionMeta(snap) {
    const meta = snap.sessionMeta;
    if (!state.debug || !meta) { els.sessionMeta.hidden = true; return; }
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push([k, v]); };
    const where = [meta.guildName, meta.channelName].filter(Boolean).join(' / ');
    add('Channel', where);
    add('Start', fmtDateTime(snap.startedAt));
    add('Wake-Word', meta.wakeword && meta.wakeword.word);
    add('Stop-Phrases', Array.isArray(meta.stopPhrases) ? meta.stopPhrases.join(', ') : null);
    add('LLM', meta.llm && [meta.llm.provider, meta.llm.model].filter(Boolean).join(' / '));
    add('STT', meta.stt && [meta.stt.provider, meta.stt.language, meta.stt.temperature != null ? `T=${meta.stt.temperature}` : null].filter(Boolean).join(' / '));
    add('TTS', meta.tts && meta.tts.provider);
    add('Version', [meta.botVersion ? `bot ${meta.botVersion}` : null, meta.serverVersion ? `server ${meta.serverVersion}` : null].filter(Boolean).join(' · '));
    if (snap.debug) add('Clock', `offset ${Math.round(snap.debug.clockOffsetMs || 0)}ms${snap.debug.lastRttMs != null ? `, rtt ${Math.round(snap.debug.lastRttMs)}ms` : ''} (${snap.debug.clockSyncCount || 0}×)`);

    els.sessionMetaBody.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      els.sessionMetaBody.appendChild(dt);
      els.sessionMetaBody.appendChild(dd);
    }
    els.sessionMeta.hidden = false;
  }

  // ── transport: SSE primary ──────────────────────────────────────────────────
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
    try { es = new EventSource(liveUrl()); } catch { startPolling(); return; }
    state.es = es;

    es.addEventListener('snapshot', (ev) => {
      state.sseFailures = 0;
      setStatus('live', 'SSE');
      try { renderSnapshot(JSON.parse(ev.data)); } catch {}
    });
    es.addEventListener('entry', (ev) => { try { upsertEntry(JSON.parse(ev.data)); } catch {} });
    es.addEventListener('presence', (ev) => { try { renderVoice(JSON.parse(ev.data)); } catch {} });
    es.addEventListener('annotation', (ev) => { try { applyAnnotation(JSON.parse(ev.data)); } catch {} });
    es.addEventListener('error', (ev) => {
      if (ev && ev.data) { try { console.warn('transcript:', JSON.parse(ev.data)); } catch {} }
    });
    es.onerror = () => {
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
      setStatus('polling', 'Polling');
      renderSnapshot(snap);
    } catch {
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
  function sessionLabel(s) {
    const when = fmtDateTime(s.startedAt != null ? s.startedAt : Number(s.sessionId));
    const where = [s.guildName, s.channelName].filter(Boolean).join(' / ');
    return where ? `${when} · ${where}` : when;
  }
  function addOption(parent, s) {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = sessionLabel(s);
    opt.title = s.sessionId; // raw id still reachable
    parent.appendChild(opt);
  }

  async function loadSessions() {
    try {
      const res = await fetch(`${baseUrl()}/sessions${state.showPast ? '?all=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      const active = (data && data.sessions) || [];
      const past = (data && data.past) || [];
      els.select.innerHTML = '';

      if (active.length === 0 && past.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(keine Session)';
        els.select.appendChild(opt);
      }
      if (active.length) {
        const g = document.createElement('optgroup'); g.label = 'Aktiv';
        for (const s of active) addOption(g, s);
        els.select.appendChild(g);
      }
      if (past.length) {
        const g = document.createElement('optgroup'); g.label = 'Vergangen';
        for (const s of past) addOption(g, s);
        els.select.appendChild(g);
      }
      if (!state.sessionId && active.length) state.sessionId = active[0].sessionId; // newest active
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
    startSse(); // fresh snapshot re-renders with/without debug fields
  });

  els.past.addEventListener('change', async () => {
    state.showPast = els.past.checked;
    await loadSessions();
  });

  els.select.addEventListener('change', () => {
    state.sessionId = els.select.value || null;
    syncUrl();
    startSse();
  });

  els.jump.addEventListener('click', () => { state.atBottom = true; scrollToBottom(); });

  window.addEventListener('scroll', () => {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    state.atBottom = nearBottom;
    if (nearBottom) els.jump.hidden = true;
  }, { passive: true });

  // Minimal test seam (only when ?e2e=1) to drive the live updater from tests
  // without a real STT/audio backend.
  if (new URLSearchParams(location.search).has('e2e')) {
    window.__transcript = { upsertEntry, clearTranscript, state };
  }

  (async function init() {
    await loadSessions();
    syncUrl();
    if (typeof EventSource !== 'undefined') startSse();
    else startPolling();
  })();
})();
