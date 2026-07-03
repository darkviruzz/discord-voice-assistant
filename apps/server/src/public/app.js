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
    showPast: params.get('past') === '1',
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

  // Locate the first stop-phrase occurrence in `text` as WHOLE words —
  // "Stopp" must not half-match the shorter phrase "stop" (which left the
  // trailing "p" unmarked). Longest phrase wins at the same position.
  function findStopToken(text, phrases) {
    let best = null;
    for (const p of phrases) {
      const needle = String(p).trim();
      if (!needle) continue;
      const body = needle.split(/\s+/)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      let re;
      try { re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu'); } catch { continue; }
      const m = re.exec(text);
      if (m && (!best || m.index < best.index
        || (m.index === best.index && m[0].length > best.length))) {
        best = { index: m.index, length: m[0].length };
      }
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

  // ── word-level live rendering (streaming STT) ──────────────────────────────
  // User utterances stream word by word: new words blur→sharpen in slowly
  // (flowtoken-style), corrected words morph (blur out, swap text at the
  // midpoint, sharpen back), words beyond entry.stableWords are dimmed until
  // the server's agreement confirms them. Paragraphs follow entry.segments.
  // Timings live in CSS (--w-enter-dur etc.); the two JS constants below must
  // stay in sync with --w-morph / --w-exit.

  const MORPH_HALF_MS = 450;
  const EXIT_MS = 400;

  function wordsOfSegment(s) { return String(s || '').trim().split(/\s+/).filter(Boolean); }

  // The word renderer applies to user speech (assistant replies are markdown,
  // debug mode keeps the per-chunk view). Wake-word/stop hits are marked on
  // the matching word spans (see computeKeywordMarks).
  function useWordRender(entry) {
    if (entry.kind !== 'user') return false;
    if (state.debug && Array.isArray(entry.chunks) && entry.chunks.length) return false;
    return Boolean((Array.isArray(entry.segments) && entry.segments.length) || entry.text);
  }

  // Match like the server's detection: case-insensitive, punctuation-free.
  function normKw(text) {
    return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  // Levenshtein distance — same tolerance as the server's fuzzy wake-word
  // detection, so "E-Rabenauge"/"Rabenauge," light up like exact hits.
  function editDistance(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
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
    if (wakeNorm.length < 4) return false; // fuzzy only for substantial words
    if (Math.abs(norm.length - wakeNorm.length) > 2) return false;
    return editDistance(norm, wakeNorm) <= 2;
  }

  // Word indices (flat across all segments) to mark for a detected wake word /
  // stop phrase. WHOLE normalized words only — "Stopp" never half-matches the
  // phrase "stop"; multi-word phrases match consecutive words; longest first.
  function computeKeywordMarks(flatWords, entry) {
    const marks = new Map(); // index → 'wake' | 'stop'
    const norms = flatWords.map(normKw);
    const mark = (phrase, cls) => {
      const seq = String(phrase || '').split(/\s+/).map(normKw).filter(Boolean);
      if (!seq.length) return;
      for (let i = 0; i + seq.length <= norms.length; i++) {
        let hit = true;
        for (let j = 0; j < seq.length; j++) {
          if (norms[i + j] !== seq[j]) { hit = false; break; }
        }
        if (hit) for (let j = 0; j < seq.length; j++) if (!marks.has(i + j)) marks.set(i + j, cls);
      }
    };
    if (entry.stopDetected) {
      for (const p of [...state.stopPhrases].sort((a, b) => b.length - a.length)) mark(p, 'stop');
    }
    if (entry.wakeDetected && state.wakeWord) {
      // Fuzzy per-word match (the server detected fuzzily too — the transcript
      // may say "E-Rabenauge" or a near-miss rather than the exact word).
      const wakeNorm = normKw(state.wakeWord);
      for (let i = 0; i < norms.length; i++) {
        if (!marks.has(i) && isWakeWordish(norms[i], wakeNorm)) marks.set(i, 'wake');
      }
    }
    return marks;
  }

  function makeWordEl(text, { animate, tentative, kw }) {
    const el = document.createElement('span');
    el.className = 'w' + (animate ? ' w-enter' : '') + (tentative ? ' w-tent' : '')
      + (kw ? ` w-kw-${kw}` : '');
    el.textContent = text;
    return el;
  }

  // Blur out, swap the text at the midpoint, sharpen back. Re-targets an
  // in-flight morph instead of stacking timers.
  function morphWord(el, text) {
    el._pendingText = text;
    if (el._morphing) return;
    el._morphing = true;
    el.classList.add('w-blur');
    setTimeout(() => {
      el.textContent = el._pendingText;
      delete el._pendingText;
      el._morphing = false;
      el.classList.remove('w-blur');
    }, MORPH_HALF_MS);
  }

  function removeWordEl(el) {
    const prev = el.previousSibling; // swallow the separating space text node
    if (prev && prev.nodeType === 3 && !prev.textContent.trim()) prev.remove();
    el.remove();
  }

  function exitWord(el) {
    if (el._exiting) return;
    el._exiting = true;
    el.classList.add('w-exit');
    setTimeout(() => removeWordEl(el), EXIT_MS);
  }

  function wordsOfPara(p) {
    return Array.from(p.querySelectorAll('.w')).filter((el) => !el._exiting);
  }

  // Patch `bodyEl` to match entry.segments word by word (append/morph/exit).
  // `stableWords` counts words across ALL segments; anything beyond is still a
  // moving hypothesis and rendered dimmed. Finals (no stableWords) undim all.
  // Detected wake/stop words get marker classes on their spans.
  function renderWordSegments(bodyEl, entry, { animate = true } = {}) {
    const segs = (Array.isArray(entry.segments) && entry.segments.length
      ? entry.segments : [entry.text || ''])
      .map(wordsOfSegment).filter((w) => w.length);
    const stable = entry.partial && Number.isFinite(entry.stableWords)
      ? entry.stableWords : Infinity;
    const marks = computeKeywordMarks(segs.flat(), entry);
    const paras = Array.from(bodyEl.children).filter((el) => el.classList.contains('w-para'));

    let wordIndex = 0;
    for (let si = 0; si < segs.length; si++) {
      let p = paras[si];
      if (!p) {
        p = document.createElement('p');
        p.className = 'w-para';
        bodyEl.appendChild(p);
      }
      const words = segs[si];
      const existing = wordsOfPara(p);
      for (let i = 0; i < words.length; i++) {
        const tentative = (wordIndex + i) >= stable;
        const kw = marks.get(wordIndex + i) ?? null;
        const cur = existing[i];
        if (!cur) {
          if (p.lastChild) p.appendChild(document.createTextNode(' '));
          p.appendChild(makeWordEl(words[i], { animate, tentative, kw }));
          continue;
        }
        const target = cur._morphing ? cur._pendingText : cur.textContent;
        if (target !== words[i]) morphWord(cur, words[i]);
        cur.classList.toggle('w-tent', tentative);
        cur.classList.toggle('w-kw-wake', kw === 'wake');
        cur.classList.toggle('w-kw-stop', kw === 'stop');
      }
      for (let i = words.length; i < existing.length; i++) exitWord(existing[i]);
      wordIndex += words.length;
    }
    for (let si = segs.length; si < paras.length; si++) {
      const p = paras[si];
      Array.from(p.querySelectorAll('.w')).forEach(exitWord);
      setTimeout(() => p.remove(), EXIT_MS + 60);
    }
  }

  // ── equal-bubble flow layout ────────────────────────────────────────────────
  // Every utterance is ONE bubble (name + time on top, text below) — bubbles
  // never contain other bubbles. Utterances that ran in parallel (time
  // overlap via startMs/endMs) form a GROUP and share the width dynamically:
  // width follows the content (fit-content) capped by a word-count share
  // (22–78%), long talkers prefer the left side, short interjections stay
  // small on the free side. A bubble lifts up NEXT to the previous one when
  // both fit in the row; otherwise it cascades with a slight edge overlap
  // (z-order by start time). Everything re-flows on every update with quick,
  // slightly springy transitions; side changes slide over (FLIP).

  let bubbleZ = 1;

  function entryWordCount(entry) {
    const segs = Array.isArray(entry.segments) && entry.segments.length
      ? entry.segments : [entry.text || ''];
    return segs.join(' ').trim().split(/\s+/).filter(Boolean).length;
  }

  // End of an utterance's time window for grouping. Partials are still open;
  // entries without a wire endMs (older logs) estimate ~165 wpm.
  function entryEndMs(entry) {
    if (entry.partial) return Infinity;
    if (Number.isFinite(entry.endMs)) return entry.endMs;
    return entry.startMs + Math.max(1500, entryWordCount(entry) * 360);
  }

  // Rendered bubbles in DOM (= start time) order.
  function bubbleRecs() {
    const out = [];
    for (const el of els.transcript.children) {
      if (!el.classList || !el.classList.contains('bubble')) continue;
      const rec = state.rendered.get(Number(el.dataset.startMs));
      if (rec) out.push(rec);
    }
    return out;
  }

  // Partition into overlap groups: a bubble joins the current group when it
  // starts before the group's latest end.
  function computeGroups(recs) {
    const groups = [];
    let cur = null;
    let curEnd = -Infinity;
    for (const rec of recs) {
      if (!cur || rec.data.startMs >= curEnd) { cur = []; groups.push(cur); curEnd = -Infinity; }
      cur.push(rec);
      curEnd = Math.max(curEnd, entryEndMs(rec.data));
    }
    return groups;
  }

  function setSide(rec, side) {
    rec._side = side;
    rec.el.classList.toggle('bubble--right', side === 'right');
  }

  // Viewport-top of the word LINE this bubble is anchored to (where the
  // interruption happened inside its host), or null when unanchored. The
  // anchor word index comes from the server (floatInto.atWordIndex, word
  // timestamps); live partials without one anchor at the host's current last
  // word — remembered once so the bubble stays put while the host grows.
  function resolveAnchorTop(rec, group) {
    const fi = rec.data.floatInto;
    if (!fi) return null;
    const host = group.find((r) => r.data.startMs === fi.hostStartMs);
    if (!host || host === rec) return null;
    const words = [];
    for (const p of host.el.querySelectorAll('.w-para')) words.push(...wordsOfPara(p));
    if (words.length === 0) return host.el.getBoundingClientRect().top;
    if (Number.isFinite(fi.atWordIndex)) rec._anchorIdx = fi.atWordIndex;
    else if (!Number.isFinite(rec._anchorIdx)) rec._anchorIdx = words.length - 1;
    const w = words[Math.max(0, Math.min(words.length - 1, rec._anchorIdx))];
    return w.getBoundingClientRect().top - 5; // bubble top edge ≈ that text line
  }

  function layoutGroup(group, narrow) {
    if (group.length === 1 || narrow) {
      // Solo bubble — or a narrow viewport, where width sharing and anchor
      // lifting would squeeze text into one-word columns: plain full-width
      // chronological list.
      for (const rec of group) {
        rec._share = 1;
        rec.el.style.maxWidth = '';
        rec.el.style.marginTop = '';
        setSide(rec, 'left');
      }
      return;
    }
    // Widths + sides first — they change line wrapping and therefore heights.
    // Shares may sum slightly above 100% (edges are allowed to overlap a bit).
    const weights = group.map((r) => Math.max(1, entryWordCount(r.data)));
    const total = weights.reduce((a, b) => a + b, 0);
    const avg = total / group.length;
    const byStart = new Map(group.map((r) => [r.data.startMs, r]));
    let prevSide = 'right';
    group.forEach((rec, i) => {
      const wc = weights[i];
      rec._share = Math.min(.78, Math.max(.24, (wc / total) * 1.06));
      // Side rule, in priority order: the first bubble sits left; an anchored
      // interjection takes the OPPOSITE side of its host (stable across ticks
      // — the alternating rule used to flip it onto the host and the collision
      // resolver then bounced it around); long talkers prefer left; everything
      // else alternates.
      let side;
      const host = rec.data.floatInto ? byStart.get(rec.data.floatInto.hostStartMs) : null;
      if (i === 0) side = 'left';
      else if (host && host !== rec) side = host._side === 'left' ? 'right' : 'left';
      else if (wc >= 25 && wc >= 1.3 * avg) side = 'left';
      else side = prevSide === 'left' ? 'right' : 'left';
      rec.el.style.maxWidth = `${Math.round(rec._share * 100)}%`;
      setSide(rec, side);
      prevSide = side;
    });
    // Vertical pass, sequential with measurements (each margin shifts the
    // natural position of everything after it): anchored bubbles rise to the
    // text line of their anchor word; unanchored ones cascade below the flow.
    // Edges may overlap up to EDGE px (this must exceed the ~2% horizontal
    // overlap the width shares produce, or the resolver fights the width rule
    // and bubbles bounce between anchor and cascade every tick). Real overlaps
    // push a bubble down below the colliding one. A small hysteresis keeps
    // margins put when the target only wobbles by a few pixels (live growth
    // shifts weights/heights slightly on every streaming tick).
    const EDGE = 26;
    const WOBBLE = 12;
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > EDGE
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EDGE;
    group[0].el.style.marginTop = '';
    const firstRect = group[0].el.getBoundingClientRect();
    const groupTop = firstRect.top;
    const placed = [firstRect];
    let flowBottom = firstRect.bottom;
    for (let i = 1; i < group.length; i++) {
      const rec = group[i];
      const prevMargin = parseInt(rec.el.style.marginTop, 10) || 0;
      rec.el.style.marginTop = '';
      const natTop = rec.el.getBoundingClientRect().top;
      let targetTop = resolveAnchorTop(rec, group);
      if (targetTop === null) targetTop = flowBottom + 2; // cascade, slight pull-up vs the 10px gap
      targetTop = Math.max(targetTop, groupTop);
      let delta = Math.round(targetTop - natTop);
      rec.el.style.marginTop = `${delta}px`;
      let rect = rec.el.getBoundingClientRect();
      for (let guard = 0; guard < 6; guard++) {
        const hit = placed.find((p) => overlaps(p, rect));
        if (!hit) break;
        delta += Math.round(hit.bottom - 8 - rect.top);
        rec.el.style.marginTop = `${delta}px`;
        rect = rec.el.getBoundingClientRect();
      }
      if (Math.abs(delta - prevMargin) <= WOBBLE && delta !== prevMargin) {
        // Close enough to last tick's position → keep it (no micro-jitter),
        // unless that would re-introduce a collision.
        rec.el.style.marginTop = `${prevMargin}px`;
        const kept = rec.el.getBoundingClientRect();
        if (placed.some((p) => overlaps(p, kept))) rec.el.style.marginTop = `${delta}px`;
        rect = rec.el.getBoundingClientRect();
      }
      placed.push(rect);
      flowBottom = Math.max(flowBottom, rect.bottom);
    }
  }

  // Full flow pass with FLIP: measure old positions, lay out with transitions
  // off (measurements must not read mid-animation values), then let every
  // moved bubble spring from its old spot to the new one.
  function layoutAll() {
    if (state.debug) return; // debug keeps the flat chronological list
    const recs = bubbleRecs();
    if (recs.length === 0) return;
    const before = new Map();
    for (const r of recs) before.set(r, r.el.getBoundingClientRect());
    const narrow = els.transcript.clientWidth < 560;
    els.transcript.classList.add('layouting');
    for (const group of computeGroups(recs)) layoutGroup(group, narrow);
    void els.transcript.offsetHeight;
    els.transcript.classList.remove('layouting');
    for (const r of recs) {
      if (r.el.classList.contains('bubble--enter')) continue; // plop-in owns its transform
      const b = before.get(r);
      const a = r.el.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        r.el.style.transition = 'none';
        r.el.style.transform = `translate(${dx}px, ${dy}px)`;
        void r.el.offsetWidth;
        r.el.style.transition = '';
        r.el.style.transform = '';
      }
    }
    if (state.atBottom) scrollToBottom();
  }

  // Animate the bubble's height across a DOM mutation (smooth growth instead
  // of jumps); keeps the view pinned to the bottom afterwards when it was.
  function withHeightTransition(el, mutate) {
    const h0 = el.offsetHeight;
    mutate();
    const h1 = el.offsetHeight;
    if (h0 === h1) return;
    el.style.height = `${h0}px`;
    el.style.overflow = 'hidden';
    void el.offsetHeight; // reflow so the transition has a start value
    el.classList.add('h-anim');
    el.style.height = `${h1}px`;
    setTimeout(() => {
      el.classList.remove('h-anim');
      el.style.height = '';
      el.style.overflow = '';
      if (state.atBottom) scrollToBottom();
    }, 380);
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
  function entryEl(entry, { animateWords = false } = {}) {
    const wrap = document.createElement('article');
    wrap.className = 'entry'
      + (entry.kind === 'assistant' ? ' entry--assistant' : '')
      + (entry.wakeDetected ? ' entry--wake' : '')
      + (entry.stopDetected ? ' entry--stop' : '');
    wrap.dataset.startMs = String(entry.startMs); // sorted insert + annotations

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
    if (useWordRender(entry)) renderWordSegments(body, entry, { animate: animateWords });
    else body.innerHTML = renderBody(entry);

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

  // One equal bubble for the flow layout (normal mode): speaker + time on top,
  // text below. Same structure for users and Rabenauge — only accent colors
  // differ. Debug mode uses entryEl() above instead.
  function bubbleEl(entry, { animateWords = false, animateIn = false } = {}) {
    const el = document.createElement('article');
    el.className = 'bubble'
      + (entry.kind === 'assistant' ? ' bubble--assistant' : '')
      + (entry.wakeDetected ? ' bubble--wake' : '')
      + (entry.stopDetected ? ' bubble--stop' : '')
      + (animateIn ? ' bubble--enter' : '');
    el.dataset.startMs = String(entry.startMs);
    el.style.zIndex = String(bubbleZ++);
    // Drop the enter class once the plop finished so later FLIP moves apply.
    if (animateIn) el.addEventListener('animationend', () => el.classList.remove('bubble--enter'), { once: true });

    const head = document.createElement('div');
    head.className = 'b-head';
    head.title = `${fmtTime(entry.startMs)} · ${entry.label || '?'}`;
    const name = document.createElement('span');
    name.className = 'b-name';
    name.textContent = entry.label || '?';
    if (entry.kind !== 'assistant') name.style.color = speakerColor(entry.label || '?');
    head.appendChild(name);
    // Inline time when the bubble has room; tiny interjections keep it in the
    // tooltip only.
    if (String(entry.text || '').length >= 15) {
      const t = document.createElement('span');
      t.className = 'b-time';
      t.textContent = fmtTime(entry.startMs);
      head.appendChild(t);
    }
    if (entry.wakeDetected) head.appendChild(badge('→ ' + state.wakeWord, 'badge-wake'));
    if (entry.stopDetected) head.appendChild(badge('Stop', 'badge-stop'));

    const body = document.createElement('div');
    body.className = 'b-body';
    if (useWordRender(entry)) renderWordSegments(body, entry, { animate: animateWords });
    else body.innerHTML = renderBody(entry);

    el.append(head, body);
    return el;
  }

  // Sync a bubble's flags/badges after a final or an annotation.
  function syncBubbleFlags(rec) {
    const e = rec.data;
    rec.el.classList.toggle('bubble--wake', !!e.wakeDetected);
    rec.el.classList.toggle('bubble--stop', !!e.stopDetected);
    const head = rec.el.querySelector('.b-head');
    if (!head) return;
    if (e.wakeDetected && !head.querySelector('.badge-wake')) head.appendChild(badge('→ ' + state.wakeWord, 'badge-wake'));
    if (e.stopDetected && !head.querySelector('.badge-stop')) head.appendChild(badge('Stop', 'badge-stop'));
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

  function pushEntry(entry, { scroll, animate = false, layout = true }) {
    if (els.emptyHint && els.emptyHint.parentNode) els.emptyHint.remove();
    const el = state.debug
      ? entryEl(entry, { animateWords: animate })
      : bubbleEl(entry, { animateWords: animate, animateIn: animate });
    // Insert in start-time order: after an SSE reconnect the snapshot only
    // contains FINALIZED utterances, so a still-running monolog's partials
    // arrive with an older startMs than lines already on screen.
    let anchor = null;
    const kids = els.transcript.querySelectorAll('.entry, .bubble');
    for (let i = kids.length - 1; i >= 0; i--) {
      if (Number(kids[i].dataset.startMs || 0) <= entry.startMs) { anchor = kids[i]; break; }
    }
    if (anchor) anchor.after(el);
    else if (kids.length) kids[0].before(el);
    else els.transcript.appendChild(el);
    state.rendered.set(entry.startMs, { data: entry, el });
    state.lastStartMs = Math.max(state.lastStartMs, entry.startMs);
    if (layout) layoutAll();
    if (scroll) {
      if (state.atBottom) scrollToBottom();
      else els.jump.hidden = false;
    }
  }

  // Insert a new entry, or update an existing one in place (same startMs). The
  // streaming STT publishes an utterance many times as words commit/appear;
  // every update re-flows the overlap group (widths/sides shift dynamically).
  function upsertEntry(entry) {
    const rec = state.rendered.get(entry.startMs);
    if (rec) {
      const bodyEl = rec.el.querySelector(state.debug ? '.entry-body' : '.b-body');
      if (useWordRender(entry) && bodyEl && (bodyEl.querySelector('.w-para') || bodyEl.children.length === 0)) {
        rec.data = entry;
        withHeightTransition(rec.el, () => renderWordSegments(bodyEl, entry, { animate: true }));
        if (state.debug) { if (!entry.partial) syncDebugFooter(rec, entry); }
        else syncBubbleFlags(rec);
      } else if (state.debug) {
        const parts = entry.kind === 'user' ? userParts(entry) : null;
        if (parts) patchEntry(rec, entry, parts);       // smooth, append-only
        else { rec.data = entry; const fresh = entryEl(entry); rec.el.replaceWith(fresh); rec.el = fresh; }
      } else if (bodyEl) {
        rec.data = entry;
        withHeightTransition(rec.el, () => { bodyEl.innerHTML = renderBody(entry); });
        syncBubbleFlags(rec);
      }
      layoutAll();
      if (state.atBottom) scrollToBottom();
      return;
    }
    // No out-of-order guard: entries are identified by startMs and inserted
    // sorted, so late partials of an older utterance render correctly.
    pushEntry(entry, { scroll: true, animate: true });
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
      syncDebugFooter(rec, entry);
    }
  }

  function syncDebugFooter(rec, entry) {
    const dbg = state.debug ? debugDetail(entry) : null;
    const oldDbg = rec.el.querySelector('.entry-debug');
    if (oldDbg && dbg) oldDbg.replaceWith(dbg);
    else if (oldDbg && !dbg) oldDbg.remove();
    else if (dbg) rec.el.appendChild(dbg);
  }

  // Retro-mark a line by startMs (wake/stop detected after it was sent).
  function applyAnnotation(ann) {
    if (!ann || ann.startMs == null) return;
    const rec = state.rendered.get(ann.startMs);
    if (!rec) return;
    if (ann.wakeDetected) rec.data.wakeDetected = true;
    if (ann.stopDetected) rec.data.stopDetected = true;
    if (!state.debug && rec.el.classList.contains('bubble')) {
      syncBubbleFlags(rec);
      const body = rec.el.querySelector('.b-body');
      // Re-run the renderer so the detected words light up in place.
      if (body && useWordRender(rec.data)) renderWordSegments(body, rec.data, { animate: false });
      else if (body) body.innerHTML = renderBody(rec.data);
      return;
    }
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
    for (const e of snap.entries) pushEntry(e, { scroll: false, layout: false });
    layoutAll(); // one flow pass over the whole history
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
    es.addEventListener('session_ended', () => {
      // Finalize ran: flip this session from active to past in the picker and
      // say so in the status pill (the transcript itself stays on screen).
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
      if (state.sessionId) {
        els.select.value = state.sessionId;
        // The viewed session may be in neither group (e.g. it just got
        // finalized and "vergangene" is unchecked) — keep it selectable.
        if (els.select.value !== state.sessionId) {
          addOption(els.select, { sessionId: state.sessionId, startedAt: Number(state.sessionId) });
          els.select.value = state.sessionId;
        }
      }
    } catch {
      /* picker stays empty; live endpoint still auto-detects newest */
    }
  }

  // ── URL sync ────────────────────────────────────────────────────────────────
  function syncUrl() {
    const p = new URLSearchParams();
    if (state.sessionId) p.set('sessionId', state.sessionId);
    if (state.debug) p.set('debug', '1');
    if (state.showPast) p.set('past', '1');
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
    syncUrl();
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
    els.past.checked = state.showPast;
    await loadSessions();
    syncUrl();
    if (typeof EventSource !== 'undefined') startSse();
    else startPolling();
  })();
})();
