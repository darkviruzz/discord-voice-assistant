/* Live-Transkript Web-UI — Vanilla JS, kein Build-Step, keine Dependencies.
 *
 * Architektur (bewusst strikt getrennt, damit Darstellungsfehler nicht wieder
 * über verstreute Patch-Pfade entstehen):
 *
 *   1. TRANSPORT   SSE /transcript/live (snapshot → entry/presence/annotation/
 *                  session_ended) mit Polling-Fallback. Schreibt NUR in den Store.
 *   2. STORE       Entries per startMs (Server-Identität; Partials und ihr
 *                  Final teilen denselben Key). Pure Ableitung: Überlapp-
 *                  Gruppen aus startMs/endMs, Anker aus floatInto.
 *   3. RENDERER    EIN idempotenter Reconcile-Pass (render()) baut den DOM auf
 *                  den Store-Zustand ab — egal ob Live-Tick, Annotation oder
 *                  kompletter Snapshot. Animationen (FLIP, SmoothHeight,
 *                  Anker-Versatz, Wort-Blur-in) hängen ausschließlich an
 *                  DOM-Differenzen dieses Passes.
 *
 * Visuals folgen dem Artefakt „transcriptanchored": Timing-Konstanten unten
 * spiegeln die CSS-Variablen in style.css — Werte synchron halten!
 */
(() => {
  'use strict';

  // ── Timing/Easing (Spiegel von style.css :root) ────────────────────────────
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  const T_FLIP = 950;      // horizontale Neuordnung (mit Ruberband)
  const T_SHAPE = 1100;    // flex-grow-Wechsel
  const T_HEIGHT = 950;    // Blockhöhe
  const T_ANCHOR = 700;    // vertikaler Anker-Versatz
  const SCROLL_TC = 620;   // Zeitkonstante Autoscroll (größer = langsamer)
  const NARROW_PX = 640;   // ab hier stapeln statt nebeneinander (wie CSS)

  const $ = (sel) => document.querySelector(sel);
  const els = {
    liveDot: $('#live-dot'),
    status: $('#status'),
    voice: $('#voice'),
    select: $('#session-select'),
    pastBtn: $('#past-toggle'),
    debugBtn: $('#debug-toggle'),
    legendSpeakers: $('#legend-speakers'),
    feed: $('#feed'),
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
    showPast: params.get('past') === '1',
    es: null,
    pollTimer: null,
    sseFailures: 0,
    live: false,             // SSE verbunden + Session aktiv → Live-Punkt
    autoScroll: true,
    stopPhrases: [],
    wakeWord: 'Rabenauge',
    // Store: startMs → rec { data, confirmed, anchor, el-Refs … }
    recs: new Map(),
    order: [],               // startMs aufsteigend
    blocks: new Map(),       // groupKey(startMs des ersten) → { outer, inner, row, settled }
  };

  // ── XSS-sichere Markdown-Miniatur (nur eigene Tags, Text vorab escaped) ────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }
  function inlineMd(s) {
    let out = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`);
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, c) => `${p}<em>${c}</em>`);
    out = out.replace(/(^|[^_])_([^_\n]+)_/g, (_m, p, c) => `${p}<em>${c}</em>`);
    out = out.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    return out;
  }
  function renderMarkdown(text) {
    const lines = escapeHtml(text).split(/\r?\n/);
    const html = [];
    let list = null;
    const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) { closeList(); continue; }
      let m;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        closeList(); html.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`);
      } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
        if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
        html.push(`<li>${inlineMd(m[1])}</li>`);
      } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
        if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
        html.push(`<li>${inlineMd(m[1])}</li>`);
      } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        closeList(); html.push(`<blockquote>${inlineMd(m[1])}</blockquote>`);
      } else {
        closeList(); html.push(`<p>${inlineMd(line)}</p>`);
      }
    }
    closeList();
    return html.join('');
  }

  // ── Sprecher-Akzente: eine feste Farbe pro Label ──────────────────────────
  // Assistant immer Teal; Nutzer bekommen Palette-Farben in Erst-Auftritts-
  // Reihenfolge (stabil für die Session, da die Map nie schrumpft).
  const ASSISTANT_ACCENT = '#4fd1c5';
  const PALETTE = ['#f6ad55', '#b794f4', '#63b3ed', '#f687b3', '#68d391', '#fbd38d', '#76e4f7'];
  const accents = new Map(); // label → { accent, assistant }
  function accentFor(label, kind) {
    const key = String(label || '?');
    let a = accents.get(key);
    if (!a) {
      const used = [...accents.values()].filter((x) => !x.assistant).length;
      a = kind === 'assistant'
        ? { accent: ASSISTANT_ACCENT, assistant: true }
        : { accent: PALETTE[used % PALETTE.length], assistant: false };
      accents.set(key, a);
      renderLegend();
    }
    return a.accent;
  }
  function initialsFor(label) {
    const parts = String(label || '?').trim().split(/\s+/);
    const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : String(parts[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }
  function renderLegend() {
    els.legendSpeakers.innerHTML = '';
    for (const [label, a] of accents) {
      const d = document.createElement('div');
      d.className = 'legend-speaker';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = a.accent;
      d.appendChild(dot);
      d.appendChild(document.createTextNode(label));
      els.legendSpeakers.appendChild(d);
    }
  }

  // ── Zeitformat ─────────────────────────────────────────────────────────────
  function fmtClock(ms) {
    const d = new Date(ms);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    return state.debug ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
  }
  function fmtDateTime(ms) {
    if (!Number.isFinite(Number(ms))) return String(ms ?? '');
    return new Date(Number(ms)).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  // ── Keyword-Markierung (Wake/Stop) — ganze normalisierte Wörter ───────────
  function normKw(w) {
    return String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }
  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_v, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  function isWakeWordish(norm, wakeNorm) {
    if (!norm || !wakeNorm) return false;
    if (norm === wakeNorm) return true;
    if (wakeNorm.length < 4) return false;
    if (Math.abs(norm.length - wakeNorm.length) > 2) return false;
    return editDistance(norm, wakeNorm) <= 2;
  }
  function computeKeywordMarks(flatWords, entry) {
    const marks = new Map(); // index → 'wake' | 'stop'
    const norms = flatWords.map(normKw);
    const mark = (phrase, cls) => {
      const seq = String(phrase || '').split(/\s+/).map(normKw).filter(Boolean);
      if (!seq.length) return;
      for (let i = 0; i + seq.length <= norms.length; i++) {
        let hit = true;
        for (let j = 0; j < seq.length; j++) if (norms[i + j] !== seq[j]) { hit = false; break; }
        if (hit) for (let j = 0; j < seq.length; j++) if (!marks.has(i + j)) marks.set(i + j, cls);
      }
    };
    if (entry.stopDetected) {
      for (const p of [...state.stopPhrases].sort((a, b) => b.length - a.length)) mark(p, 'stop');
    }
    if (entry.wakeDetected && state.wakeWord) {
      const wakeNorm = normKw(state.wakeWord);
      for (let i = 0; i < norms.length; i++) {
        if (!marks.has(i) && isWakeWordish(norms[i], wakeNorm)) marks.set(i, 'wake');
      }
    }
    return marks;
  }

  // ── STORE ──────────────────────────────────────────────────────────────────
  function segmentsOf(entry) {
    const segs = Array.isArray(entry.segments) && entry.segments.length
      ? entry.segments : [entry.text || ''];
    return segs.map((s) => String(s || '').split(/\s+/).filter(Boolean)).filter((w) => w.length);
  }
  function wordCountOf(entry) {
    return segmentsOf(entry).reduce((n, w) => n + w.length, 0);
  }
  function endOf(entry) {
    if (entry.partial) return Infinity;
    if (Number.isFinite(entry.endMs)) return entry.endMs;
    return entry.startMs + Math.max(1500, wordCountOf(entry) * 360); // ~165 wpm
  }

  // Entry einfügen/mergen. Identität = startMs (Partials → Final gleicher Key).
  function upsertEntry(entry, { animate = true } = {}) {
    if (!entry || !Number.isFinite(entry.startMs)) return;
    let rec = state.recs.get(entry.startMs);
    if (!rec) {
      rec = { data: entry, confirmed: 0, animate, anchorIdx: null, els: null, dirty: true };
      state.recs.set(entry.startMs, rec);
      const i = state.order.findIndex((s) => s > entry.startMs);
      if (i < 0) state.order.push(entry.startMs); else state.order.splice(i, 0, entry.startMs);
    } else {
      // Final ersetzt Partial; Annotationen/verspätete Felder bleiben erhalten.
      rec.data = { ...rec.data, ...entry };
      // Finals kommen OHNE partial-Flag (der Draht setzt es nur bei true) —
      // der Merge darf das alte true nicht überleben lassen, sonst bleibt die
      // Blase ewig „live" (Caret, offene Gruppe, gedimmter Schwanz).
      rec.data.partial = entry.partial === true;
      rec.dirty = true;
    }
    // Bestätigt-Zähler monoton halten (Server-stableWords kann pro Tick nur
    // wachsen; nach dem Final gilt alles als bestätigt).
    if (rec.data.partial && Number.isFinite(rec.data.stableWords)) {
      rec.confirmed = Math.max(rec.confirmed, rec.data.stableWords);
    }
    if (!rec.data.partial) rec.confirmed = Infinity;
    if (els.emptyHint) { els.emptyHint.remove(); els.emptyHint = null; }
    render();
  }

  // Retro-Annotation (Wake/Stop erkannt, Interruption klassifiziert).
  function applyAnnotation(ann) {
    if (!ann || !Number.isFinite(ann.startMs)) return;
    const rec = state.recs.get(ann.startMs);
    if (!rec) return;
    if (ann.wakeDetected) rec.data.wakeDetected = true;
    if (ann.stopDetected) rec.data.stopDetected = true;
    if (ann.floatInto) rec.data.floatInto = ann.floatInto;
    rec.dirty = true;
    render();
  }

  function resetStore() {
    state.recs.clear();
    state.order.length = 0;
    state.blocks.clear();
    accents.clear();
    renderLegend();
    els.feed.innerHTML = '';
    els.emptyHint = null;
  }

  // Überlapp-Gruppen (Zeitfenster): Entry gehört zur offenen Gruppe, wenn es
  // vor deren spätestem Ende beginnt ODER per floatInto explizit hinein zeigt.
  function computeGroups() {
    const groups = [];
    let cur = null;
    let curEnd = -Infinity;
    let curSet = null;
    for (const startMs of state.order) {
      const rec = state.recs.get(startMs);
      const host = rec.data.floatInto?.hostStartMs;
      const joins = cur && (startMs < curEnd || (host != null && curSet.has(host)));
      if (!joins) { cur = []; curSet = new Set(); groups.push(cur); curEnd = -Infinity; }
      cur.push(rec);
      curSet.add(startMs);
      curEnd = Math.max(curEnd, endOf(rec.data));
    }
    return groups;
  }

  // ── RENDERER ───────────────────────────────────────────────────────────────
  const narrow = () => window.innerWidth < NARROW_PX;

  function makeBubble(rec) {
    const e = rec.data;
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (rec.animate ? ' bubble--enter' : '');
    if (rec.animate) {
      bubble.addEventListener('animationend', () => bubble.classList.remove('bubble--enter'), { once: true });
    }
    const head = document.createElement('div');
    head.className = 'b-head';
    const avatar = document.createElement('div');
    avatar.className = 'b-avatar';
    const name = document.createElement('span');
    name.className = 'b-name';
    const time = document.createElement('span');
    time.className = 'b-time';
    head.append(avatar, name, time);
    const body = document.createElement('div');
    body.className = e.kind === 'assistant' ? 'b-md' : 'b-body';
    bubble.append(head, body);

    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.startMs = String(e.startMs);
    slot.appendChild(bubble);
    rec.els = { slot, bubble, avatar, name, time, body, debug: null, mdKey: null };
    return rec.els;
  }

  // Wort-Spans eines Segments mit dem Soll abgleichen (append/replace/exit).
  function reconcileWords(segEl, words, baseIdx, confirmed, marks, animate) {
    const existing = Array.from(segEl.querySelectorAll('.w')).filter((w) => !w._exiting);
    for (let i = 0; i < words.length; i++) {
      const flat = baseIdx + i;
      const tent = flat >= confirmed;
      const kw = marks.get(flat) ?? null;
      const cls = 'w' + (tent ? ' w--tent' : '') + (kw ? ` w--${kw}` : '');
      let span = existing[i];
      if (!span) {
        span = document.createElement('span');
        span.className = cls + (animate ? ' w--in' : '');
        span.textContent = words[i];
        if (segEl.lastChild) segEl.appendChild(document.createTextNode(' '));
        segEl.appendChild(span);
        continue;
      }
      if (span.textContent !== words[i]) {
        // Neues Wort remountet mit Blur-in (Artefakt: Key `${i}-${w}`).
        const fresh = document.createElement('span');
        fresh.className = cls + (animate ? ' w--in' : '');
        fresh.textContent = words[i];
        span.replaceWith(fresh);
      } else {
        span.className = cls; // nur Zustandsklassen (tent/kw) nachziehen
      }
    }
    for (let i = words.length; i < existing.length; i++) {
      const span = existing[i];
      if (span._exiting) continue;
      span._exiting = true;
      span.classList.add('w--out');
      setTimeout(() => {
        const prev = span.previousSibling;
        if (prev && prev.nodeType === 3 && !prev.textContent.trim()) prev.remove();
        span.remove();
      }, 240);
    }
  }

  function chunkSplitTag(split) {
    const s = String(split || '');
    const cls = s.startsWith('natural') ? 'chunk--natural'
      : s.startsWith('forced') ? 'chunk--forced'
        : s.startsWith('stream') ? 'chunk--stream' : 'chunk--other';
    const tag = document.createElement('span');
    tag.className = `chunk-split ${cls}`;
    tag.textContent = s;
    return tag;
  }

  function updateBubble(rec) {
    const e = rec.data;
    const { bubble, avatar, name, time, body } = rec.els;
    const accent = accentFor(e.label, e.kind);
    bubble.style.setProperty('--accent', accent);
    bubble.classList.toggle('bubble--ended', !e.partial);
    avatar.textContent = initialsFor(e.label);
    name.textContent = e.label || '?';
    time.textContent = fmtClock(e.startMs);

    if (e.kind === 'assistant') {
      // Markdown-Body; nur bei Textänderung neu rendern.
      if (rec.els.mdKey !== e.text) {
        rec.els.mdKey = e.text;
        body.innerHTML = renderMarkdown(e.text || '');
      }
    } else {
      // Debug: Roh-Chunks mit Split-Tags; sonst Segmente (Absatz je Gruppe).
      const useChunks = state.debug && Array.isArray(e.chunks) && e.chunks.length;
      const segs = useChunks
        ? e.chunks.map((c) => String(c.text || '').split(/\s+/).filter(Boolean))
        : segmentsOf(e);
      const splits = useChunks ? e.chunks.map((c) => c.split) : null;
      const flatWords = segs.flat();
      const marks = computeKeywordMarks(flatWords, e);
      const segEls = Array.from(body.children).filter((el) => el.classList.contains('seg'));
      let base = 0;
      for (let si = 0; si < segs.length; si++) {
        let segEl = segEls[si];
        if (!segEl) {
          segEl = document.createElement('p');
          segEl.className = 'seg';
          body.appendChild(segEl);
        }
        if (splits && !segEl.querySelector('.chunk-split')) {
          segEl.prepend(chunkSplitTag(splits[si]));
        }
        reconcileWords(segEl, segs[si], base, rec.confirmed, marks, rec.animate);
        base += segs[si].length;
      }
      for (let si = segs.length; si < segEls.length; si++) segEls[si].remove();

      // Caret ans Ende des letzten Segments, solange live.
      let caret = body.querySelector('.caret');
      if (e.partial) {
        const last = body.lastElementChild;
        if (!caret) { caret = document.createElement('span'); caret.className = 'caret'; }
        if (last && caret.parentNode !== last) last.appendChild(caret);
      } else if (caret) {
        caret.remove();
      }
    }

    // Debug-Fußzeile (nur final, nur Debug-Modus).
    const wantDebug = state.debug && !e.partial;
    if (wantDebug && !rec.els.debug) {
      const d = document.createElement('div');
      d.className = 'b-debug';
      const meta = e.meta || {};
      const bits = [`start ${fmtClock(e.startMs)}`];
      if (Number.isFinite(e.endMs)) bits.push(`dauer ${((e.endMs - e.startMs) / 1000).toFixed(1)}s`);
      if (meta.noSpeechProb != null) bits.push(`noSpeech ${Number(meta.noSpeechProb).toFixed(3)}`);
      if (e.floatInto) bits.push(`float→${fmtClock(e.floatInto.hostStartMs)}${Number.isFinite(e.floatInto.atWordIndex) ? `@${e.floatInto.atWordIndex}` : ''}`);
      d.textContent = bits.join(' · ');
      rec.els.bubble.appendChild(d);
      rec.els.debug = d;
    } else if (!wantDebug && rec.els.debug) {
      rec.els.debug.remove();
      rec.els.debug = null;
    }
  }

  // Anker: Slot eines Unterbrechers auf die Wortzeile seines Hosts ausrichten.
  function anchorTargetPx(rec, group, rowTop) {
    const fi = rec.data.floatInto;
    let host = null;
    let idx = null;
    if (fi && fi.hostStartMs != null) {
      host = group.find((r) => r.data.startMs === fi.hostStartMs && r !== rec) || null;
      if (Number.isFinite(fi.atWordIndex)) idx = fi.atWordIndex;
    }
    if (!host) {
      // Implizit: nicht-erste Blase der Gruppe hängt am längsten früher
      // gestarteten Mitglied (Artefakt-Regel), Position beim Beitritt gemerkt.
      const before = group.filter((r) => r !== rec && r.data.startMs < rec.data.startMs);
      if (!before.length) return 0;
      host = before.sort((a, b) => wordCountOf(b.data) - wordCountOf(a.data)
        || a.data.startMs - b.data.startMs)[0];
    }
    const words = host.els ? host.els.bubble.querySelectorAll('.w') : [];
    if (!words.length) return 0;
    if (idx === null) {
      if (rec.anchorIdx === null) rec.anchorIdx = words.length - 1; // einmal merken
      idx = rec.anchorIdx;
    }
    const span = words[Math.max(0, Math.min(words.length - 1, idx))];
    return Math.max(0, span.getBoundingClientRect().top - rowTop);
  }

  let renderScheduled = false;
  function render() {
    // Mehrere Store-Updates im selben Tick → ein Reconcile-Pass.
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => { renderScheduled = false; renderPass(); });
  }

  function renderPass() {
    const groups = computeGroups();
    const isNarrow = narrow();

    // Nur OFFENE Blöcke werden gemessen/animiert — abgeschlossene Gruppen sind
    // statisch; ohne diesen Guard erzwänge jeder Tick O(n) Reflows über die
    // gesamte Historie.
    const activeRecs = [];
    for (const group of groups) {
      const blk = state.blocks.get(group[0].data.startMs);
      if (!blk || !blk.settled) activeRecs.push(...group);
    }

    // 1. FLIP-Vorher-Messung (nur Slots offener Blöcke, die es schon gibt).
    const prevRect = new Map();
    for (const rec of activeRecs) {
      if (rec.els?.slot.isConnected) prevRect.set(rec.data.startMs, rec.els.slot.getBoundingClientRect());
    }

    // 2. DOM abgleichen: Blöcke in Gruppen-Reihenfolge, Slots in Dominanz-Ordnung.
    const seenBlocks = new Set();
    let anchorBlock = null; // als Nächstes einzufügender Block hängt hier dahinter
    for (const group of groups) {
      const key = group[0].data.startMs;
      seenBlocks.add(key);
      let blk = state.blocks.get(key);
      if (!blk) {
        const outer = document.createElement('div');
        outer.className = 'block';
        const inner = document.createElement('div');
        const row = document.createElement('div');
        row.className = 'row';
        inner.appendChild(row);
        outer.appendChild(inner);
        blk = { outer, inner, row, settled: false, lastH: null };
        state.blocks.set(key, blk);
        if (anchorBlock) anchorBlock.after(outer);
        else els.feed.prepend(outer);
      }
      anchorBlock = blk.outer;

      // Dominanz: meiste Wörter zuerst, dann Startzeit (Artefakt-Sortierung).
      const ordered = [...group].sort((a, b) => wordCountOf(b.data) - wordCountOf(a.data)
        || a.data.startMs - b.data.startMs);
      const solo = ordered.length === 1;
      blk.row.classList.toggle('row--multi', !solo);

      const targetSlots = ordered.map((rec) => (rec.els ?? makeBubble(rec)).slot);
      const currentSlots = Array.from(blk.row.children);
      const orderChanged = targetSlots.length !== currentSlots.length
        || targetSlots.some((s, i) => currentSlots[i] !== s);
      if (orderChanged) for (const s of targetSlots) blk.row.appendChild(s);

      ordered.forEach((rec, i) => {
        const slot = rec.els.slot;
        slot.classList.toggle('slot--solo', solo);
        slot.style.flexGrow = solo ? '1' : (i === 0 ? '2.2' : '1');
        if (rec.dirty) { updateBubble(rec); rec.dirty = false; }
      });

      // Gruppe abgeschlossen? → Höhe freigeben, nicht mehr messen.
      const open = group.some((r) => r.data.partial);
      if (!open && !blk.settled) {
        blk.settled = true;
        setTimeout(() => {
          blk.outer.style.height = 'auto';
          blk.outer.classList.add('block--settled');
        }, T_HEIGHT + 60);
      } else if (open && blk.settled) {
        blk.settled = false;
        blk.outer.classList.remove('block--settled');
        blk.lastH = null;
      }
    }
    // Verwaiste Blöcke (Gruppen-Neuzuschnitt nach Snapshot) entfernen.
    for (const [key, blk] of state.blocks) {
      if (!seenBlocks.has(key)) { blk.outer.remove(); state.blocks.delete(key); }
    }

    // 3. Anker-Versatz (nach Layout; misst Wortzeilen im Host).
    if (!isNarrow) {
      for (const group of groups) {
        if (group.length < 2) continue;
        const blk = state.blocks.get(group[0].data.startMs);
        if (blk.settled) continue; // eingefrorene Blöcke behalten ihren Versatz
        const rowTop = blk.row.getBoundingClientRect().top;
        for (const rec of group) {
          const slot = rec.els.slot;
          const target = anchorTargetPx(rec, group, rowTop);
          const first = !slot._anchored;
          slot._anchored = true;
          slot.style.transitionProperty = 'margin-top, transform, flex-grow';
          slot.style.transitionDuration = first ? '0ms' : `${T_ANCHOR}ms`;
          slot.style.transitionTimingFunction = EASE;
          slot.style.marginTop = `${target}px`;
        }
      }
    }

    // 4. SmoothHeight: Außenhöhe der offenen Blöcke weich nachführen.
    for (const group of groups) {
      const blk = state.blocks.get(group[0].data.startMs);
      if (blk.settled) continue;
      const h = blk.inner.offsetHeight;
      if (blk.lastH === null) {
        blk.outer.style.height = `${h}px`; // erster Frame: ohne Transition
        blk.outer.style.transition = 'none';
        void blk.outer.offsetHeight;
        blk.outer.style.transition = `height ${T_HEIGHT}ms ${EASE}`;
      } else if (blk.lastH !== h) {
        blk.outer.style.height = `${h}px`;
      }
      blk.lastH = h;
    }

    // 5. FLIP-Nachher: horizontale Verschiebungen mit Ruberband animieren.
    if (!isNarrow) {
      for (const rec of activeRecs) {
        const slot = rec.els?.slot;
        const prev = prevRect.get(rec.data.startMs);
        if (!slot || !prev || !slot.isConnected) continue;
        const next = slot.getBoundingClientRect();
        const dx = prev.left - next.left;
        if (Math.abs(dx) > 1) {
          slot.style.transition = 'none';
          slot.style.transform = `translateX(${dx}px)`;
          void slot.offsetWidth;
          slot.style.transitionProperty = 'transform, margin-top, flex-grow';
          slot.style.transitionDuration = `${T_FLIP}ms, ${T_ANCHOR}ms, ${T_SHAPE}ms`;
          slot.style.transitionTimingFunction = `${EASE_SPRING}, ${EASE}, ${EASE}`;
          slot.style.transform = '';
        }
      }
    }
  }

  // ── Autoscroll (weiches exponentielles Nachziehen ans Feed-Ende) ───────────
  (function scrollLoop() {
    let last = performance.now();
    function tick(now) {
      const dt = now - last;
      last = now;
      if (state.autoScroll) {
        const feed = els.feed;
        const target = feed.scrollHeight - feed.clientHeight;
        const delta = target - feed.scrollTop;
        if (delta > 0.4) feed.scrollTop += delta * (1 - Math.exp(-dt / SCROLL_TC));
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  function disableAuto() {
    if (!state.autoScroll) return;
    state.autoScroll = false;
    els.jump.hidden = false;
  }
  function enableAuto() {
    state.autoScroll = true;
    els.jump.hidden = true;
  }
  els.feed.addEventListener('wheel', (e) => { if (e.deltaY < 0) disableAuto(); }, { passive: true });
  let touchY = 0;
  els.feed.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  els.feed.addEventListener('touchmove', (e) => {
    if (e.touches[0].clientY - touchY > 6) disableAuto();
  }, { passive: true });
  els.feed.addEventListener('scroll', () => {
    if (state.autoScroll) return;
    const dist = els.feed.scrollHeight - els.feed.clientHeight - els.feed.scrollTop;
    if (dist < 36) enableAuto();
  }, { passive: true });
  els.jump.addEventListener('click', () => {
    els.feed.scrollTop = els.feed.scrollHeight - els.feed.clientHeight;
    enableAuto();
  });
  window.addEventListener('resize', () => {
    // Breitenwechsel: Höhen der offenen Blöcke neu messen.
    for (const blk of state.blocks.values()) { if (!blk.settled) blk.lastH = null; }
    render();
  });

  // ── Status / Voice / Meta / Summary ────────────────────────────────────────
  function setStatus(kind, text) {
    els.status.className = `pill pill--${kind}`;
    els.status.textContent = text;
    state.live = kind === 'live';
    els.liveDot.classList.toggle('live-dot--on', state.live);
  }

  function renderVoice(voice) {
    if (!voice) {
      els.voice.className = 'pill pill--unknown';
      els.voice.textContent = '🎙 unbekannt';
      els.membersPop.hidden = true;
      return;
    }
    const n = (voice.members || []).length;
    if (voice.populated) {
      els.voice.className = 'pill pill--connected';
      els.voice.textContent = `🎙 verbunden · ${n} im Channel`;
    } else if (voice.connected) {
      els.voice.className = 'pill pill--alone';
      els.voice.textContent = '🎙 verbunden · allein';
    } else {
      els.voice.className = 'pill pill--offline';
      els.voice.textContent = '🎙 nicht verbunden';
    }
    els.membersList.innerHTML = '';
    els.membersCount.textContent = String(n);
    els.membersPop.hidden = n === 0;
    for (const m of voice.members || []) {
      const li = document.createElement('li');
      li.textContent = m.label || '?';
      li.style.color = accentFor(m.label || '?', 'user');
      els.membersList.appendChild(li);
    }
  }

  function renderSessionMeta(snap) {
    const meta = snap.sessionMeta;
    if (!state.debug || !meta) { els.sessionMeta.hidden = true; return; }
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push([k, v]); };
    add('Channel', [meta.guildName, meta.channelName].filter(Boolean).join(' / '));
    add('Start', fmtDateTime(snap.startedAt));
    add('Wake-Word', meta.wakeword && meta.wakeword.word);
    add('Stop-Phrases', Array.isArray(meta.stopPhrases) ? meta.stopPhrases.join(', ') : null);
    add('LLM', meta.llm && [meta.llm.provider, meta.llm.model].filter(Boolean).join(' / '));
    add('STT', meta.stt && [meta.stt.provider, meta.stt.language,
      meta.stt.temperature != null ? `T=${meta.stt.temperature}` : null].filter(Boolean).join(' / '));
    add('TTS', meta.tts && meta.tts.provider);
    add('Version', [meta.botVersion ? `bot ${meta.botVersion}` : null,
      meta.serverVersion ? `server ${meta.serverVersion}` : null].filter(Boolean).join(' · '));
    if (snap.debug) {
      add('Clock', `offset ${Math.round(snap.debug.clockOffsetMs || 0)}ms`
        + `${snap.debug.lastRttMs != null ? `, rtt ${Math.round(snap.debug.lastRttMs)}ms` : ''}`
        + ` (${snap.debug.clockSyncCount || 0}×)`);
    }
    els.sessionMetaBody.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      els.sessionMetaBody.append(dt, dd);
    }
    els.sessionMeta.hidden = false;
  }

  function renderSnapshot(snap) {
    resetStore();
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
    if (!snap.entries || !snap.entries.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Noch nichts transkribiert.';
      els.feed.appendChild(p);
      els.emptyHint = p;
      return;
    }
    for (const e of snap.entries) upsertEntry(e, { animate: false });
    // Historie ohne Einschwingen: sofort ans Ende springen.
    requestAnimationFrame(() => {
      els.feed.scrollTop = els.feed.scrollHeight - els.feed.clientHeight;
    });
  }

  // ── TRANSPORT: SSE primär, Polling-Fallback ────────────────────────────────
  function baseUrl() { return location.pathname.replace(/\/[^/]*$/, ''); }
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
      try { renderSnapshot(JSON.parse(ev.data)); } catch (e) { console.warn('snapshot render:', e); }
    });
    es.addEventListener('entry', (ev) => {
      try { upsertEntry(JSON.parse(ev.data)); } catch (e) { console.warn('entry:', e); }
    });
    es.addEventListener('presence', (ev) => { try { renderVoice(JSON.parse(ev.data)); } catch {} });
    es.addEventListener('annotation', (ev) => { try { applyAnnotation(JSON.parse(ev.data)); } catch {} });
    es.addEventListener('session_ended', () => {
      setStatus('ended', 'Session beendet');
      loadSessions();
    });
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

  // ── Session-Picker ─────────────────────────────────────────────────────────
  function sessionLabel(s) {
    const when = fmtDateTime(s.startedAt != null ? s.startedAt : Number(s.sessionId));
    const where = [s.guildName, s.channelName].filter(Boolean).join(' / ');
    return where ? `${when} · ${where}` : when;
  }
  function addOption(parent, s) {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = sessionLabel(s);
    opt.title = s.sessionId;
    parent.appendChild(opt);
  }
  async function loadSessions() {
    try {
      const res = await fetch(`${baseUrl()}/sessions${state.showPast ? '?all=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      const active = (data && data.sessions) || [];
      const past = (data && data.past) || [];
      els.select.innerHTML = '';
      if (!active.length && !past.length) {
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
      if (!state.sessionId && active.length) state.sessionId = active[0].sessionId;
      if (state.sessionId) {
        els.select.value = state.sessionId;
        if (els.select.value !== state.sessionId) {
          addOption(els.select, { sessionId: state.sessionId, startedAt: Number(state.sessionId) });
          els.select.value = state.sessionId;
        }
      }
    } catch { /* Picker bleibt leer; /live erkennt die neueste Session selbst */ }
  }

  // ── URL-Sync + Wiring ──────────────────────────────────────────────────────
  function syncUrl() {
    const p = new URLSearchParams();
    if (state.sessionId) p.set('sessionId', state.sessionId);
    if (state.debug) p.set('debug', '1');
    if (state.showPast) p.set('past', '1');
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  els.debugBtn.classList.toggle('btn--active', state.debug);
  document.body.classList.toggle('debug', state.debug);
  els.debugBtn.addEventListener('click', () => {
    state.debug = !state.debug;
    els.debugBtn.classList.toggle('btn--active', state.debug);
    document.body.classList.toggle('debug', state.debug);
    syncUrl();
    startSse(); // frischer Snapshot rendert mit/ohne Debug-Felder
  });

  els.pastBtn.classList.toggle('btn--active', state.showPast);
  els.pastBtn.addEventListener('click', async () => {
    state.showPast = !state.showPast;
    els.pastBtn.classList.toggle('btn--active', state.showPast);
    syncUrl();
    await loadSessions();
  });

  els.select.addEventListener('change', () => {
    state.sessionId = els.select.value || null;
    syncUrl();
    startSse();
  });

  // Test-Seam (nur ?e2e=1): Live-Updater ohne echtes Audio/STT ansteuern.
  if (params.has('e2e')) {
    window.__transcript = { upsertEntry, applyAnnotation, renderSnapshot, resetStore, state };
  }

  (async function init() {
    await loadSessions();
    syncUrl();
    if (typeof EventSource !== 'undefined') startSse();
    else startPolling();
  })();
})();
