import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTranscript,
  buildModelFromEvents,
  speakerLabel,
  _internal,
} from '../src/finalize/merge.js';

const BASE = 1_700_000_000_000; // fixed epoch for deterministic timestamps
const TZ = 'UTC';
const OPTS = { timeZone: TZ, wakeWord: 'Rabenauge', stopPhrases: ['stop', 'halt'], assistantName: 'Rabenauge' };

function userSpan(label, startMs, endMs, text, words = null) {
  return { type: 'user', userId: label, label, startMs, endMs, text, words };
}

test('chronological ordering of non-overlapping utterances', () => {
  const model = {
    sessionStartMs: BASE,
    spans: [
      userSpan('Greta', BASE + 3000, BASE + 4000, 'Zweiter Satz.'),
      userSpan('Hauke', BASE + 0, BASE + 1000, 'Erster Satz.'),
    ],
  };
  const md = mergeTranscript(model, OPTS);
  const iHauke = md.indexOf('Erster Satz');
  const iGreta = md.indexOf('Zweiter Satz');
  assert.ok(iHauke > 0 && iGreta > 0);
  assert.ok(iHauke < iGreta, 'Hauke (earlier start) must render before Greta');
  assert.match(md, /\*\*Hauke:\*\*/);
});

test('interrupt splits a monologue at word boundaries with markers', () => {
  const words = [
    { w: 'Ich', t0: 0, t1: 300 },
    { w: 'gehe', t0: 400, t1: 700 },
    { w: 'durch', t0: 800, t1: 1100 },
    { w: 'die', t0: 1200, t1: 1400 },
    { w: 'Tür', t0: 5000, t1: 5300 },
  ];
  const model = {
    sessionStartMs: BASE,
    spans: [
      userSpan('Hauke', BASE + 0, BASE + 5300, 'Ich gehe durch die Tür', words),
      userSpan('Greta', BASE + 2000, BASE + 2800, 'Moment!'),
    ],
  };
  const md = mergeTranscript(model, OPTS);

  const iPart1 = md.indexOf('Ich gehe durch die');
  const iGreta = md.indexOf('Moment!');
  const iPart2 = md.indexOf('Tür');
  assert.ok(iPart1 >= 0 && iGreta >= 0 && iPart2 >= 0);
  assert.ok(iPart1 < iGreta, 'first fragment before interrupter');
  assert.ok(iGreta < iPart2, 'interrupter before continuation');

  assert.match(md, /\*\*Greta:\*\* _\[unterbricht\]_/);
  assert.match(md, /\*\*Hauke:\*\* _\[weiter\]_ Tür/);
});

test('missing word timestamps → no split (utterance-level fallback)', () => {
  const model = {
    sessionStartMs: BASE,
    spans: [
      userSpan('Hauke', BASE + 0, BASE + 5000, 'Ein langer Satz ohne Wort-Zeitstempel hier.'),
      userSpan('Greta', BASE + 2000, BASE + 2500, 'Kurz!'),
    ],
  };
  const md = mergeTranscript(model, OPTS);
  assert.doesNotMatch(md, /_\[weiter\]_/, 'no continuation marker without words');
  // Whole utterance stays verbatim and intact.
  assert.match(md, /Ein langer Satz ohne Wort-Zeitstempel hier\./);
  // Greta still flagged as interrupter (began during Hauke's span).
  assert.match(md, /\*\*Greta:\*\* _\[unterbricht\]_ Kurz!/);
});

test('pause header inserted for gaps over threshold', () => {
  const model = {
    sessionStartMs: BASE,
    spans: [
      userSpan('Hauke', BASE + 0, BASE + 1000, 'Vor der Pause.'),
      userSpan('Hauke', BASE + 1000 + 5 * 60_000, BASE + 1000 + 5 * 60_000 + 1000, 'Nach der Pause.'),
    ],
  };
  const md = mergeTranscript(model, { ...OPTS, pauseThresholdS: 30 });
  assert.match(md, /## \d{2}:\d{2} — Pause \(5 min\)/);
});

test('no pause header for short gaps', () => {
  const model = {
    sessionStartMs: BASE,
    spans: [
      userSpan('Hauke', BASE + 0, BASE + 1000, 'A.'),
      userSpan('Hauke', BASE + 10_000, BASE + 11_000, 'B.'),
    ],
  };
  const md = mergeTranscript(model, { ...OPTS, pauseThresholdS: 30 });
  assert.doesNotMatch(md, /Pause/);
});

test('wake word / stop phrases are bolded only when actually detected', () => {
  const detected = userSpan('Hauke', BASE, BASE + 2000, 'Rabenauge, öffne die Tür.');
  detected.wakeDetected = true;
  const stop = userSpan('Greta', BASE + 3000, BASE + 3500, 'Stop bitte.');
  stop.stopDetected = true;
  const md = mergeTranscript({ sessionStartMs: BASE, spans: [detected, stop] }, OPTS);
  assert.match(md, /\*\*Rabenauge\*\*, öffne/);
  assert.match(md, /\*\*Stop\*\* bitte/);
});

test('wake word is NOT bolded when no detection flag is set', () => {
  // e.g. wake word said too late in the sentence → no trigger.
  const model = {
    sessionStartMs: BASE,
    spans: [userSpan('Hauke', BASE, BASE + 2000, 'Ja gut, Rabenauge hätte ich fast vergessen.')],
  };
  const md = mergeTranscript(model, OPTS);
  assert.doesNotMatch(md, /\*\*Rabenauge\*\*/);
  assert.match(md, /Rabenauge hätte/);
});

test('detection flags derive from wakeword_query / stop_command events', () => {
  const sid = String(BASE);
  const events = [
    { type: 'user_transcript', sessionId: sid, tsMs: BASE + 1600, userId: '111', userDisplayName: 'Hauke',
      startTsMs: BASE, endTsMs: BASE + 1500, text: 'Rabenauge was ist das' },
    { type: 'wakeword_query', sessionId: sid, tsMs: BASE + 1700, userId: '111', query: 'was ist das' },
  ];
  const model = buildModelFromEvents(events, {});
  assert.equal(model.spans[0].wakeDetected, true);
  const md = mergeTranscript(model, OPTS);
  assert.match(md, /\*\*Rabenauge\*\* was ist das/);
});

test('bracket-only transcripts are dropped', () => {
  const sid = String(BASE);
  const events = [
    { type: 'user_transcript', sessionId: sid, tsMs: BASE, userId: '1', startTsMs: BASE, endTsMs: BASE + 500, text: '[Musik]' },
    { type: 'user_transcript', sessionId: sid, tsMs: BASE + 1000, userId: '1', startTsMs: BASE + 1000, endTsMs: BASE + 1500, text: 'Hallo [Rascheln] zusammen' },
  ];
  const model = buildModelFromEvents(events, {});
  assert.equal(model.spans.length, 1, '[Musik] dropped, mixed line kept');
  assert.match(model.spans[0].text, /Hallo/);
});

test('normalizeText collapses STT newlines in rendered lines', () => {
  const model = { sessionStartMs: BASE, spans: [userSpan('Hauke', BASE, BASE + 2000, 'Erste Zeile.\nZweite Zeile.\n\nDritte.')] };
  const md = mergeTranscript(model, OPTS);
  assert.match(md, /Erste Zeile\. Zweite Zeile\. Dritte\./);
});

test('interrupted assistant uses the played (truncated) text', () => {
  const sid = String(BASE);
  const events = [
    { type: 'assistant_response', sessionId: sid, tsMs: BASE + 2000, turnId: 't1', text: 'Die Tür ist verschlossen und dahinter lauert ein Drache.' },
    { type: 'assistant_response_played', sessionId: sid, tsMs: BASE + 2500, turnId: 't1', truncated: true, text: 'Die Tür ist verschlossen ...' },
  ];
  const model = buildModelFromEvents(events, {});
  const asst = model.spans.find((s) => s.type === 'assistant');
  assert.equal(asst.text, 'Die Tür ist verschlossen ...');
  assert.equal(asst.interrupted, true);
});

test('participants carry join/leave times from voice_member events', () => {
  const sid = String(BASE);
  const events = [
    { type: 'voice_member', sessionId: sid, tsMs: BASE, userId: '111', displayName: 'Hauke', state: 'join' },
    { type: 'user_transcript', sessionId: sid, tsMs: BASE + 5000, userId: '111', userDisplayName: 'Hauke', startTsMs: BASE + 5000, endTsMs: BASE + 6000, text: 'Hallo.' },
    { type: 'voice_member', sessionId: sid, tsMs: BASE + 600000, userId: '111', displayName: 'Hauke', state: 'leave' },
  ];
  const model = buildModelFromEvents(events, {});
  assert.equal(model.participants.length, 1);
  assert.equal(model.participants[0].joinMs, BASE);
  assert.equal(model.participants[0].leftMs, BASE + 600000);
  const md = mergeTranscript({ ...model, channelName: 'X' }, OPTS);
  assert.match(md, /\*\*Teilnehmer:\*\* Hauke \(\d{2}:\d{2}–\d{2}:\d{2}\)/);
});

test('assistant text is not keyword-bolded and uses assistant label', () => {
  const model = {
    sessionStartMs: BASE,
    spans: [
      { type: 'assistant', label: 'Rabenauge', startMs: BASE, endMs: BASE + 2000, text: 'Die Tür ist verschlossen.' },
    ],
  };
  const md = mergeTranscript(model, OPTS);
  assert.match(md, /\*\*Rabenauge:\*\* Die Tür ist verschlossen\./);
});

test('online→offline seam: events-derived + audio-only spans interleave by time', () => {
  // Online span carries an assistant reply; the later span is audio-only (server
  // was offline) — both must order purely by start time.
  const model = {
    sessionStartMs: BASE,
    spans: [
      userSpan('Hauke', BASE + 0, BASE + 1500, 'Rabenauge, was ist das?'),
      { type: 'assistant', label: 'Rabenauge', startMs: BASE + 2000, endMs: BASE + 4000, text: 'Ein Drache.' },
      userSpan('Greta', BASE + 5000, BASE + 6000, 'Oha, ein Drache!'),
    ],
  };
  const md = mergeTranscript(model, OPTS);
  const a = md.indexOf('was ist das');
  const b = md.indexOf('Ein Drache.');
  const c = md.indexOf('Oha, ein Drache');
  assert.ok(a < b && b < c, 'strict chronological order across online/offline seam');
});

test('empty model yields a placeholder line', () => {
  const md = mergeTranscript({ sessionStartMs: BASE, spans: [] }, OPTS);
  assert.match(md, /Keine transkribierten Äußerungen/);
});

// ── buildModelFromEvents ──────────────────────────────────────────────────────

test('buildModelFromEvents maps JSONL events to spans with bot-clock times', () => {
  const sid = String(BASE);
  const events = [
    { type: 'session_meta', sessionId: sid, tsMs: BASE + 10 },
    { type: 'clock_sync', sessionId: sid, tsMs: BASE + 20, offsetMs: 1000 },
    { type: 'user_transcript', sessionId: sid, tsMs: BASE + 1600, userId: '111', userDisplayName: 'Hauke',
      startTsMs: BASE + 100, endTsMs: BASE + 1500, durationMs: 1400, text: 'Hallo Welt.', words: null },
    // assistant_response stamped on server clock (+1000ms ahead) → normalized back.
    { type: 'assistant_response', sessionId: sid, tsMs: BASE + 3000, text: 'Antwort.' },
  ];
  const model = buildModelFromEvents(events, { speakerMap: { '111': { player: 'Hauke', character: 'Thrain' } } });
  assert.equal(model.sessionStartMs, BASE);
  assert.equal(model.clockOffsetMs, 1000);

  const user = model.spans.find((s) => s.type === 'user');
  assert.equal(user.startMs, BASE + 100, 'uses bot-clock startTsMs directly');
  assert.equal(user.label, 'Hauke (Thrain)');

  const asst = model.spans.find((s) => s.type === 'assistant');
  assert.equal(asst.startMs, BASE + 3000 - 1000, 'assistant time normalized by clock offset');
});

test('buildModelFromEvents skips empty transcripts and includes typed queries', () => {
  const sid = String(BASE);
  const events = [
    { type: 'user_transcript', sessionId: sid, tsMs: BASE, userId: '1', text: '', words: null },
    { type: 'text_query', sessionId: sid, tsMs: BASE + 500, userId: '2', userDisplayName: 'Greta', text: 'Wie spät ist es?' },
  ];
  const model = buildModelFromEvents(events, {});
  assert.equal(model.spans.length, 1);
  assert.ok(model.spans[0].typed);
});

test('speakerLabel falls back through map → displayName → id', () => {
  assert.equal(speakerLabel('1', 'Hauke', { '1': { player: 'H', character: 'Thrain' } }), 'H (Thrain)');
  assert.equal(speakerLabel('1', 'Hauke', { '1': { player: 'H' } }), 'H');
  assert.equal(speakerLabel('1', 'Hauke', {}), 'Hauke');
  assert.equal(speakerLabel('1', null, {}), '1');
});

test('resolveClockOffset prefers median clock_sync over session_meta', () => {
  const events = [
    { type: 'session_meta', clockOffsetMs: 999 },
    { type: 'clock_sync', offsetMs: 100 },
    { type: 'clock_sync', offsetMs: 300 },
    { type: 'clock_sync', offsetMs: 200 },
  ];
  assert.equal(_internal.resolveClockOffset(events), 200);
  assert.equal(_internal.resolveClockOffset([{ type: 'session_meta', clockOffsetMs: 42 }]), 42);
  assert.equal(_internal.resolveClockOffset([]), 0);
});

// ── assistant interruption weaving (real-data fixture) ─────────────────────────

test('weaveAssistantTurns splits an interrupted LLM turn with rewind + interrupters', () => {
  const sid = '1780058709544';
  // Subset of a real session: one assistant turn, interrupted twice with rewinds.
  const events = [
    { type: 'clock_sync', sessionId: sid, tsMs: 1780059282375, offsetMs: -878, rttMs: 0 },
    { type: 'user_transcript', sessionId: sid, tsMs: 1780059258851, userId: '696665320185659453', userDisplayName: 'Dhorik',
      startTsMs: 1780059252997, endTsMs: 1780059257997, durationMs: 5000, text: 'Ok, Rabenauge, kannst du mir kurz erzählen, was gerade passiert ist?' },
    { type: 'wakeword_query', sessionId: sid, tsMs: 1780059258851, userId: '696665320185659453', query: 'kannst du mir kurz erzählen, was gerade passiert ist?' },
    { type: 'user_transcript', sessionId: sid, tsMs: 1780059275032, userId: '696665320185659453', userDisplayName: 'Dhorik',
      startTsMs: 1780059271540, endTsMs: 1780059272040, durationMs: 500, text: '[SILENCE]' },
    { type: 'assistant_response', sessionId: sid, tsMs: 1780059279877, turnId: 't1', userId: '696665320185659453',
      text: 'Ihr habt gerade die alte Schriftrolle untersucht und dabei die geheime Inschrift entdeckt. Diese Inschrift deutet darauf hin, dass die nächste Stadt das Verlies eines mächtigen Magiers birgt.' },
    { type: 'tts_start', sessionId: sid, tsMs: 1780059279878, turnId: 't1', id: 'tts-1', text: 'Ihr habt gerade …' },
    { type: 'tts_done', sessionId: sid, tsMs: 1780059280414, turnId: 't1', frames: 474, durationMs: 9480 },
    { type: 'playback_paused', sessionId: sid, tsMs: 1780059280478, id: 'tts-1', interruptedByUserId: '696665320185659453', msPlayed: 320, framesPlayed: 16 },
    { type: 'playback_resumed', sessionId: sid, tsMs: 1780059282555, id: 'tts-1', rewoundMs: 320, msPlayed: 320 },
    { type: 'user_transcript', sessionId: sid, tsMs: 1780059282900, userId: '696665320185659453', userDisplayName: 'Dhorik',
      startTsMs: 1780059280556, endTsMs: 1780059282156, durationMs: 1600, text: 'Okay, noch einmal.' },
    { type: 'playback_paused', sessionId: sid, tsMs: 1780059285057, id: 'tts-1', interruptedByUserId: '696665320185659453', msPlayed: 2860, framesPlayed: 143 },
    { type: 'playback_resumed', sessionId: sid, tsMs: 1780059286317, id: 'tts-1', rewoundMs: 1000, msPlayed: 2860 },
    { type: 'user_transcript', sessionId: sid, tsMs: 1780059286637, userId: '696665320185659453', userDisplayName: 'Dhorik',
      startTsMs: 1780059285134, endTsMs: 1780059285914, durationMs: 780, text: 'Mhm.' },
    { type: 'user_transcript', sessionId: sid, tsMs: 1780059301452, userId: '696665320185659453', userDisplayName: 'Dhorik',
      startTsMs: 1780059299137, endTsMs: 1780059300697, durationMs: 1560, text: 'Ah, okay, danke.' },
  ];

  const model = buildModelFromEvents(events, { speakerMap: { '696665320185659453': { player: 'Dhorik' } } });
  const md = mergeTranscript(model, { ...OPTS, wakeWord: 'Rabenauge' });

  // Three assistant segments.
  const asst = model.spans.filter((s) => s.type === 'assistant');
  assert.equal(asst.length, 3, 'turn split into 3 segments');
  assert.match(asst[0].text, /^Ihr habt/);
  assert.equal(asst[0].forceMarker, null);
  assert.equal(asst[1].forceMarker, 'weiter');
  assert.equal(asst[2].forceMarker, 'weiter');
  assert.match(asst[2].text, /birgt\.$/, 'final segment runs to the end');

  // [SILENCE] dropped; interrupters woven once each.
  assert.doesNotMatch(md, /SILENCE/);
  assert.equal((md.match(/Okay, noch einmal\./g) || []).length, 1);
  assert.match(md, /_\[unterbricht\]_ Okay, noch einmal\./);
  assert.match(md, /_\[unterbricht\]_ Mhm\./);
  assert.match(md, /_\[weiter\]_/);

  // Order: seg0 ("Ihr habt") → Okay → seg1 → Mhm → final ("… birgt.").
  const order = ['Ihr habt', 'Okay, noch einmal', 'Mhm.', 'birgt.'];
  let pos = -1;
  for (const needle of order) {
    const at = md.indexOf(needle);
    assert.ok(at > pos, `"${needle}" out of order`);
    pos = at;
  }
});
