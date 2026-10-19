import { transcribe } from './stt.js';
import { sttProviderLabel } from './providers/stt.js';
import { applyCorrections } from './sttPostprocess.js';
import { debug, warn } from './logger.js';
import opus from '@discordjs/opus';

const { OpusEncoder } = opus;

// ── Audio helpers (shared with pipeline.js) ──────────────────────────────────

export const SAMPLE_RATE = 48000;

export function opusFramesToPcm(opusBuffers) {
  const dec = new OpusEncoder(48000, 1);
  return Buffer.concat(opusBuffers.map(b => dec.decode(b)));
}

// Build a minimal 44-byte WAV header around a PCM buffer.
export function pcmToWav(pcm, sampleRate = 48000, channels = 1, bitDepth = 16) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);        hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);        hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);   hdr.writeUInt16LE(1,          20); // PCM
  hdr.writeUInt16LE(channels, 22); hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate, 28); hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(bitDepth, 34);
  hdr.write('data', 36);       hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

// ── Word assembly ────────────────────────────────────────────────────────────
// whisper.cpp word timestamps are TOKEN-level: a token starting with a space
// begins a new word; a token without one continues the previous word (sub-word
// pieces like " Ab"+"brechen") or glues punctuation ("Witz"+"."). Merging
// tokens into display words gives LocalAgreement stable units — token
// boundaries jitter between runs, word text does not.
//
// Word-level providers (OpenAI-compatible servers returning whole words
// without leading spaces) are normalised to the same convention in
// providers/stt.js (normalizeWordList) — every token arriving here follows it.

export function normWord(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// tokens: [{ w, t0, t1, raw? }] (seconds). Returns [{ text, norm, t0, t1 }].
export function mergeTokensToWords(tokens) {
  const words = [];
  let cur = null;
  for (const tok of tokens) {
    const raw = String(tok.raw ?? ` ${tok.w}`).replace(/[\r\n]+/g, ' ');
    const startsWord = cur === null || /^\s/.test(raw);
    if (startsWord) {
      if (cur) words.push(cur);
      cur = { text: raw.trim(), t0: tok.t0, t1: tok.t1 };
    } else {
      cur.text += raw.trim();
      cur.t1 = tok.t1;
    }
  }
  if (cur) words.push(cur);
  for (const w of words) w.norm = normWord(w.text);
  return words.filter((w) => w.text.length > 0);
}

// Longest common prefix of two word arrays (normalized comparison; falls back
// to exact text for pure-punctuation words whose norm is empty).
export function agreedPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n) {
    const x = a[i], y = b[i];
    const same = (x.norm && y.norm) ? x.norm === y.norm : x.text === y.text;
    if (!same) break;
    i++;
  }
  return i;
}

export function endsSentence(text) {
  return /[.!?…]["»«"'’)\]]*$/u.test(String(text || '').trim());
}

// Weaker boundary (clause end) — acceptable trim point when the window is
// getting long and no committed sentence end exists yet.
export function endsClause(text) {
  return /[.!?…,;:]["»«"'’)\]]*$/u.test(String(text || '').trim());
}

// Whisper sound-event annotations ("[Musik]", "[SCHLÜSSE]", "(Applaus)") —
// hallucinated on tiny/low-energy windows; never transcript material.
function isBracketArtifact(text) {
  return /^[\[(].*[\])]$/.test(String(text || '').trim());
}

// Hallucination loops ("der Erkrankung der Erkrankung der …") show up as a
// bigram repeating ≥3× — real speech almost never does that back-to-back.
export function looksRepetitive(words) {
  if (words.length < 6) return false;
  const counts = new Map();
  for (let i = 0; i + 1 < words.length; i++) {
    const g = `${words[i].norm} ${words[i + 1].norm}`;
    const n = (counts.get(g) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(g, n);
  }
  return false;
}

function joinWords(words) {
  return words.map((w) => w.text).join(' ');
}

function numberEnv(name, fallback, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

// ── Streaming transcriber (LocalAgreement-2) ─────────────────────────────────
// True streaming STT against a batch STT server (whisper.cpp or any
// OpenAI-compatible one, see providers/stt.js): every tick re-
// transcribes the speaker's active window (start of utterance → now, minus
// already-locked audio). Words that two consecutive hypotheses agree on are
// COMMITTED (shown live, never retracted); once committed audio spans
// STT_STREAM_TRIM_SECONDS, the window is trimmed at the last committed
// sentence end and its text is LOCKED (final — the utterance-end pass will not
// re-transcribe that audio). The re-decoded window stays ≤ ~25 s, so per-tick
// GPU cost is bounded regardless of utterance length, and the forced-overlap
// splitting (with its error-prone text dedup) is never needed on this path.

const SOFT_MAX_WINDOW_SEC = 20;  // long window: clause ends become trim points
const HARD_MAX_WINDOW_SEC = 25;  // force a trim before whisper's 30 s limit
const FINAL_MAX_WINDOW_SEC = 29; // finalize() refuses windows beyond this

export function createSttStream({
  label = null,
  startMs = Date.now(),
  transcribeFn = transcribe,
} = {}) {
  const st = {
    windowStartSample: 0,
    lockedGroups: [],      // final text, one entry per trimmed window (→ paragraphs)
    lockedWordsMs: [],     // [{ w, t0, t1 }] ms since utterance start (absolute)
    lockedMetas: [],       // [{ chars, durationMs, meta }] per locked group
    lockedWordCount: 0,    // display words across all locked groups
    committed: [],         // agreed words of the CURRENT window (window-relative s)
    prevHyp: null,         // previous tick's hypothesis for the current window
    hasTimes: true,        // false once a hypothesis came back without timestamps
    lastMeta: null,
    lastTickSamples: 0,    // skip ticks when no new audio arrived
    lastText: '',          // change-detection key of the last published tick
    lastSegments: [],      // display segments of the last published tick
    ticks: 0,
    busy: false,
    detached: false,
  };

  const windowStartSec = () => st.windowStartSample / SAMPLE_RATE;
  // The whole utterance so far (locked audio included), not just the window:
  // decides whether the vocabulary goes into the prompt (STT_VOCABULARY_MIN_MS).
  const utteranceMs = (pcm48k) => (pcm48k.length / 2 / SAMPLE_RATE) * 1000;

  // Locked text as context, with the correction map applied, so a near-miss
  // ("Rhoga") is not fed back to Whisper as the spelling to continue.
  function promptText() {
    if ((process.env.STT_STREAM_PROMPT ?? 'true') === 'false') return undefined;
    const locked = applyCorrections(st.lockedGroups.join(' ').trim());
    return locked ? locked.slice(-200) : undefined;
  }

  // Lock committed words [0..cutIdx] as a finished group and advance the window
  // past them. Remaining committed words are re-based onto the new window.
  function lockThrough(cutIdx) {
    const group = st.committed.slice(0, cutIdx + 1);
    if (group.length === 0) return;
    const baseSec = windowStartSec();
    const cutWord = group[group.length - 1];
    const next = st.committed[cutIdx + 1] ?? null;
    // Cut in the gap after the sentence end when there is one — whisper's t1
    // can clip a trailing phoneme; the midpoint keeps both sides intact.
    const cutSec = next && next.t0 > cutWord.t1
      ? (cutWord.t1 + next.t0) / 2
      : cutWord.t1;

    st.lockedGroups.push(joinWords(group));
    st.lockedWordCount += group.length;
    for (const w of group) {
      st.lockedWordsMs.push({
        w: w.text,
        t0: Math.round((baseSec + w.t0) * 1000),
        t1: Math.round((baseSec + w.t1) * 1000),
      });
    }
    st.lockedMetas.push({
      chars: joinWords(group).length,
      durationMs: Math.round(cutSec * 1000),
      meta: st.lastMeta,
    });

    st.windowStartSample += Math.round(cutSec * SAMPLE_RATE);
    st.committed = st.committed.slice(cutIdx + 1).map((w) => ({
      ...w,
      t0: Math.max(0, w.t0 - cutSec),
      t1: Math.max(0, w.t1 - cutSec),
    }));
    st.prevHyp = null;        // window moved → agreement restarts next tick
    st.lastTickSamples = 0;   // and the next tick must not be skipped
    debug(`sttStream: locked group #${st.lockedGroups.length} (${st.lockedGroups[st.lockedGroups.length - 1].length} chars), window now starts at ${windowStartSec().toFixed(1)}s`);
  }

  // Current display state: locked paragraphs plus the active window's committed
  // words and (optionally) the still-unstable tail of the latest hypothesis.
  function segmentsSnapshot(tailTexts = []) {
    const current = [...st.committed.map((w) => w.text), ...tailTexts].join(' ').trim();
    const segments = [...st.lockedGroups];
    if (current) segments.push(current);
    return segments;
  }

  function sttMeta(tailMeta, tailDurationMs, tailChars) {
    const parts = [
      ...st.lockedMetas,
      ...(tailMeta !== undefined ? [{ chars: tailChars, durationMs: tailDurationMs, meta: tailMeta }] : []),
    ];
    let weighted = 0, weight = 0, max = null;
    for (const p of parts) {
      const avg = p.meta?.noSpeechProbAvg;
      if (typeof avg !== 'number') continue;
      const w = Math.max(1, p.chars || 1);
      weighted += avg * w;
      weight += w;
      const m = p.meta?.noSpeechProbMax;
      if (typeof m === 'number') max = max === null ? m : Math.max(max, m);
    }
    return {
      // Stamped by providers/stt.js on each result; injected test
      // transcribers return none → the current setting.
      provider: [...parts.map((p) => p.meta), st.lastMeta].find((m) => m?.provider)?.provider ?? sttProviderLabel(),
      mode: 'stream',
      ticks: st.ticks,
      noSpeechProbAvg: weight > 0 ? weighted / weight : null,
      noSpeechProbMax: max,
      chunkDurationsMs: parts.map((p) => p.durationMs),
      splitTypes: parts.map((_, i) => (i < st.lockedMetas.length ? 'stream-locked' : 'stream-final')),
      chunks: parts.map((p, i) => ({
        index: i,
        durationMs: p.durationMs,
        splitType: i < st.lockedMetas.length ? 'stream-locked' : 'stream-final',
        hasOverlap: false,
        textLength: p.chars,
        segmentCount: p.meta?.segmentCount ?? 0,
        noSpeechProbAvg: p.meta?.noSpeechProbAvg ?? null,
        noSpeechProbMax: p.meta?.noSpeechProbMax ?? null,
        language: p.meta?.language ?? null,
      })),
    };
  }

  return {
    label,
    startMs,
    get busy() { return st.busy; },
    get ticks() { return st.ticks; },
    get state() { return st; },

    detach() { st.detached = true; },

    hasContent() {
      return st.lockedGroups.length > 0 || st.committed.length > 0 || st.ticks > 0;
    },

    // Current display state for snapshot rebuilds (page load / SSE reconnect
    // mid-utterance): what the last published partial showed.
    snapshot() {
      return {
        segments: st.lastSegments.slice(),
        text: st.lastSegments.join(' '),
        stableWords: st.lockedWordCount + st.committed.length,
      };
    },

    windowSeconds(pcm48k) {
      return Math.max(0, pcm48k.length / 2 - st.windowStartSample) / SAMPLE_RATE;
    },

    // One streaming step over the utterance-so-far PCM. Returns null when
    // nothing new happened, else { changed, text, segments, chunks }.
    async tick(pcm48k) {
      if (st.busy || st.detached) return null;
      const totalSamples = pcm48k.length / 2;
      const windowSamples = totalSamples - st.windowStartSample;
      if (windowSamples < (numberEnv('STT_STREAM_MIN_WINDOW_MS', 1000, 200) / 1000) * SAMPLE_RATE) return null;
      if (totalSamples === st.lastTickSamples) return null; // no new audio since last tick

      st.busy = true;
      try {
        st.lastTickSamples = totalSamples;
        const window = pcm48k.subarray(st.windowStartSample * 2);
        const { meta, words: tokens, text } = await transcribeFn(pcmToWav(window), {
          prompt: promptText(), audioMs: utteranceMs(pcm48k),
        });
        if (st.detached) return null;
        st.ticks++;
        st.lastMeta = meta;

        let hyp;
        if (Array.isArray(tokens) && tokens.length > 0) {
          hyp = mergeTokensToWords(tokens);
        } else {
          // Degraded mode: no word timestamps → agree on plain text words.
          hyp = String(text || '').split(/\s+/).filter(Boolean)
            .map((t) => ({ text: t, norm: normWord(t), t0: null, t1: null }));
          if (hyp.length > 0) st.hasTimes = false;
        }
        // Sound-event annotations must neither commit nor display.
        hyp = hyp.filter((w) => !isBracketArtifact(w.text));

        if (st.prevHyp) {
          const n = agreedPrefixLen(st.prevHyp, hyp);
          if (n > st.committed.length) st.committed = hyp.slice(0, n);
        }
        // Unstable remainder of the hypothesis — displayed live, may still
        // change. Hallucination loops are held back from display (agreement
        // still sees them internally and will never commit them).
        const tailWords = hyp.slice(st.committed.length);
        const tailTexts = looksRepetitive(tailWords) ? [] : tailWords.map((w) => w.text);
        st.prevHyp = hyp;

        const windowSec = windowSamples / SAMPLE_RATE;
        if (st.hasTimes && st.committed.length > 0) {
          const lastCommitted = st.committed[st.committed.length - 1];
          const trimSec = numberEnv('STT_STREAM_TRIM_SECONDS', 15, 5);
          if (lastCommitted.t1 >= trimSec || windowSec >= SOFT_MAX_WINDOW_SEC) {
            let cut = -1;
            for (let i = st.committed.length - 1; i >= 0; i--) {
              if (endsSentence(st.committed[i].text)) { cut = i; break; }
            }
            // Escalating fallbacks: on a long window accept a clause end
            // (comma etc.), on a critical one any committed word — a window
            // that starts mid-clause makes whisper hallucinate sentence
            // starts, which stalls agreement even longer.
            if (cut < 0 && windowSec >= SOFT_MAX_WINDOW_SEC) {
              for (let i = st.committed.length - 1; i >= 0; i--) {
                if (endsClause(st.committed[i].text)) { cut = i; break; }
              }
            }
            if (cut < 0 && windowSec >= HARD_MAX_WINDOW_SEC) cut = st.committed.length - 1;
            if (cut >= 0) lockThrough(cut);
          }
        } else if (windowSec >= HARD_MAX_WINDOW_SEC + 3 && hyp.length > 0) {
          // Agreement never landed (or no timestamps) and the window is about
          // to exceed whisper's limit: lock the current hypothesis wholesale.
          warn(`sttStream: force-locking ${hyp.length} unagreed words at ${windowSec.toFixed(1)}s window`);
          st.committed = hyp;
          if (st.hasTimes) {
            lockThrough(st.committed.length - 1);
          } else {
            st.lockedGroups.push(joinWords(hyp));
            st.lockedWordCount += hyp.length;
            st.lockedMetas.push({ chars: joinWords(hyp).length, durationMs: Math.round(windowSec * 1000), meta: st.lastMeta });
            st.windowStartSample = totalSamples;
            st.committed = [];
            st.prevHyp = null;
            st.lastTickSamples = 0;
          }
          tailTexts.length = 0;
        }

        const segments = segmentsSnapshot(tailTexts);
        const snapText = segments.join(' ');
        // Words up to stableWords are locked/committed — the client may animate
        // anything beyond that index, it is still a moving hypothesis. A tick
        // that only PROMOTES words from tail to committed keeps the text equal
        // but must still be published (the client un-dims those words).
        const stableWords = st.lockedWordCount + st.committed.length;
        const snapKey = `${stableWords}:${snapText}`;
        if (snapKey === st.lastText) return { changed: false };
        st.lastText = snapKey;
        st.lastSegments = segments;
        return {
          changed: true,
          text: snapText,
          segments,
          chunks: segments.map((s) => ({ text: s, split: 'stream' })),
          stableWords,
        };
      } catch (e) {
        debug('sttStream tick error:', e.message);
        return null;
      } finally {
        st.busy = false;
      }
    },

    // Authoritative pass at utterance end: transcribe the remaining window once
    // (complete audio — no agreement needed) and combine with the locked
    // groups. The caller must have verified windowSeconds() ≤ FINAL_MAX_WINDOW_SEC.
    async finalize(pcm48k) {
      st.detached = true;
      const windowSamples = pcm48k.length / 2 - st.windowStartSample;
      const windowSec = Math.max(0, windowSamples) / SAMPLE_RATE;
      if (windowSec > FINAL_MAX_WINDOW_SEC) {
        throw new Error(`sttStream.finalize: window ${windowSec.toFixed(1)}s exceeds ${FINAL_MAX_WINDOW_SEC}s`);
      }

      let tailText = '';
      let tailWords = [];
      let tailMeta;
      let anyTailTimes = false;
      if (windowSec >= 0.25) {
        const window = pcm48k.subarray(st.windowStartSample * 2);
        const { text, meta, words: tokens } = await transcribeFn(pcmToWav(window), {
          prompt: promptText(), audioMs: utteranceMs(pcm48k),
        });
        tailMeta = meta;
        if (Array.isArray(tokens) && tokens.length > 0) {
          let merged = mergeTokensToWords(tokens).filter((w) => !isBracketArtifact(w.text));
          // Words the agreement already committed were confirmed by TWO
          // independent passes — keep them and take from this final pass only
          // what lies AFTER the last committed word (time cut + 1-word seam
          // dedup). A single fresh pass may hallucinate a new sentence start
          // and must not retract words the UI already showed as stable.
          if (st.hasTimes && st.committed.length > 0) {
            const last = st.committed[st.committed.length - 1];
            const fresh = merged.filter((w) => w.t0 >= last.t1 - 0.05);
            if (fresh.length > 0 && fresh[0].norm && fresh[0].norm === last.norm) fresh.shift();
            merged = [...st.committed, ...fresh];
          }
          tailText = joinWords(merged);
          const baseSec = windowStartSec();
          tailWords = merged.map((w) => ({
            w: w.text,
            t0: Math.round((baseSec + w.t0) * 1000),
            t1: Math.round((baseSec + w.t1) * 1000),
          }));
          anyTailTimes = true;
        } else {
          tailText = String(text || '').trim();
        }
      } else if (st.committed.length > 0) {
        // Remaining window is empty/near-empty — the committed words ARE the tail.
        tailText = joinWords(st.committed);
        if (st.hasTimes) {
          const baseSec = windowStartSec();
          tailWords = st.committed.map((w) => ({
            w: w.text,
            t0: Math.round((baseSec + w.t0) * 1000),
            t1: Math.round((baseSec + w.t1) * 1000),
          }));
          anyTailTimes = true;
        }
      }

      const segments = [...st.lockedGroups];
      if (tailText) segments.push(tailText);
      const words = (st.hasTimes && (anyTailTimes || !tailText))
        ? [...st.lockedWordsMs, ...tailWords]
        : null;
      return {
        text: segments.join(' '),
        segments,
        rawChunks: segments.map((s, i) => ({
          text: s,
          split: i < st.lockedGroups.length ? 'stream-locked' : 'stream-final',
        })),
        words: words && words.length > 0 ? words : null,
        stt: sttMeta(tailMeta, Math.round(windowSec * 1000), tailText.length),
      };
    },
  };
}
