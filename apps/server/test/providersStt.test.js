import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcribe, cleanWhisperText } from '../src/stt.js';
import {
  sttConfig, sttProvider, normalizeWordList, parseWords, _resetSttProviderState,
} from '../src/providers/stt.js';
import { createSttStream, mergeTokensToWords, pcmToWav } from '../src/sttStreaming.js';
import { transcribeChunked } from '../src/pipeline.js';
import { transcribeWavFile } from '../src/finalize/sttFile.js';

// One fake STT server speaking both dialects (whisper.cpp /inference and
// OpenAI /audio/transcriptions). Requests are parsed as real multipart bodies.
const seen = [];
// reply(req, form, n) → { status?, json?, text?, type?, delayMs?, stallBodyMs? }
let reply = null;
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] ?? '' } })
      .formData().catch(() => null);
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, form });
    const r = reply(req, form, seen.length);
    const body = r.text !== undefined ? r.text : JSON.stringify(r.json ?? {});
    const type = r.type ?? (r.text !== undefined ? 'text/plain; charset=utf-8' : 'application/json');
    setTimeout(() => {
      res.writeHead(r.status ?? 200, type ? { 'Content-Type': type } : {});
      if (r.stallBodyMs) {
        // Headers + half the body now, the rest much later: the timeout must
        // also cover a reply that stalls mid-body.
        res.write(body.slice(0, Math.floor(body.length / 2)));
        setTimeout(() => res.end(body.slice(Math.floor(body.length / 2))), r.stallBodyMs);
      } else {
        res.end(body);
      }
    }, r.delayMs ?? 0);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.closeAllConnections?.(); srv.close(); });

const KEYS = ['STT_PROVIDER', 'STT_BASE_URL', 'STT_MODEL', 'STT_API_KEY', 'STT_LANGUAGE', 'STT_TIMEOUT_MS',
  'WHISPER_URL', 'WHISPER_LANGUAGE', 'WHISPER_TEMPERATURE', 'WHISPER_WORD_TIMESTAMPS',
  'STT_STREAM_MIN_WINDOW_MS', 'STT_STREAM_TRIM_SECONDS', 'STT_STREAM_PROMPT', 'STT_MAX_CHUNK_SECONDS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  seen.length = 0;
  _resetSttProviderState();
});

const SR = 48000;
const wavOfSeconds = (sec) => pcmToWav(Buffer.alloc(Math.round(sec * SR) * 2));
const pcmOfSeconds = (sec) => Buffer.alloc(Math.round(sec * SR) * 2);

function useOpenAI(extra = {}) {
  Object.assign(process.env, { STT_PROVIDER: 'openai', STT_BASE_URL: `${BASE}/v1`, ...extra });
}

// ── whisper.cpp (default) — parity with the pre-provider stt.js ──────────────

test('whispercpp (default): /inference multipart fields, cleaned text, no_speech meta, raw tokens', async () => {
  process.env.WHISPER_URL = `${BASE}/`;
  process.env.WHISPER_LANGUAGE = 'de';
  process.env.WHISPER_TEMPERATURE = '0.1';
  reply = () => ({
    json: {
      text: ' Entwicklung befind\nliche Welt.',
      language: 'german',
      segments: [
        { text: ' Entwicklung befind', no_speech_prob: 0.1, words: [
          { word: ' Entwicklung', start: 0.0, end: 0.6 }, { word: ' befind', start: 0.7, end: 1.0 }] },
        { text: 'liche Welt.', no_speech_prob: 0.4, words: [
          { word: 'liche', start: 1.0, end: 1.2 }, { word: ' Welt', start: 1.3, end: 1.6 }, { word: '.', start: 1.6, end: 1.65 }] },
      ],
    },
  });
  const wav = wavOfSeconds(1);
  const r = await transcribe(wav, { prompt: 'x'.repeat(600) + 'ENDE' });

  assert.equal(seen[0].url, '/inference');
  assert.equal(seen[0].auth, null);
  const f = seen[0].form;
  const file = f.get('file');
  assert.equal(file.name, 'audio.wav');
  assert.equal(file.type, 'audio/wav');
  assert.equal(file.size, wav.length);
  assert.equal(f.get('language'), 'de');
  assert.equal(f.get('response_format'), 'verbose_json');
  assert.equal(f.get('temperature'), '0.1');
  assert.equal(f.get('prompt').length, 500, 'prompt = last 500 chars');
  assert.ok(f.get('prompt').endsWith('ENDE'));
  assert.deepEqual(f.getAll('timestamp_granularities[]'), ['word']);
  assert.equal(f.get('model'), null, 'whisper.cpp gets no model field');

  assert.equal(r.text, 'Entwicklung befindliche Welt.');
  assert.equal(r.meta.provider, 'whisper.cpp');
  assert.equal(r.meta.language, 'german');
  assert.equal(r.meta.temperature, 0.1);
  assert.equal(r.meta.segmentCount, 2);
  // weighted by segment text length: (0.1*18 + 0.4*11) / 29
  assert.ok(Math.abs(r.meta.noSpeechProbAvg - (0.1 * 18 + 0.4 * 11) / 29) < 1e-9, String(r.meta.noSpeechProbAvg));
  assert.equal(r.meta.noSpeechProbMax, 0.4);
  assert.equal(r.meta.wordCount, 5);
  // Token convention preserved verbatim → sub-word pieces merge downstream.
  assert.deepEqual(r.words.map((w) => w.raw), [' Entwicklung', ' befind', 'liche', ' Welt', '.']);
  assert.deepEqual(mergeTokensToWords(r.words).map((w) => w.text), ['Entwicklung', 'befindliche', 'Welt.']);
});

test('whispercpp: language auto / word timestamps off / no prompt → fields omitted; defaults as before', async () => {
  process.env.WHISPER_URL = BASE;
  process.env.WHISPER_LANGUAGE = 'auto';
  process.env.WHISPER_WORD_TIMESTAMPS = 'false';
  reply = () => ({ json: { text: 'Hallo' } });
  const r = await transcribe(wavOfSeconds(0.5));
  const f = seen[0].form;
  assert.equal(f.get('language'), null);
  assert.equal(f.get('prompt'), null);
  assert.deepEqual(f.getAll('timestamp_granularities[]'), []);
  assert.equal(f.get('temperature'), '0.2', 'code default temperature');
  assert.equal(r.text, 'Hallo');
  assert.equal(r.words, null);
  assert.deepEqual(
    { language: r.meta.language, segmentCount: r.meta.segmentCount, avg: r.meta.noSpeechProbAvg, max: r.meta.noSpeechProbMax },
    { language: null, segmentCount: 0, avg: null, max: null });
  assert.equal('wordCount' in r.meta, false);
});

test('STT_LANGUAGE overrides WHISPER_LANGUAGE for both providers', async () => {
  process.env.WHISPER_URL = BASE;
  process.env.WHISPER_LANGUAGE = 'en';
  process.env.STT_LANGUAGE = 'de';
  reply = () => ({ json: { text: 'x' } });
  await transcribe(wavOfSeconds(0.2));
  assert.equal(seen[0].form.get('language'), 'de');
  process.env.STT_LANGUAGE = 'auto';
  await transcribe(wavOfSeconds(0.2));
  assert.equal(seen[1].form.get('language'), null);
  delete process.env.STT_LANGUAGE;
  await transcribe(wavOfSeconds(0.2));
  assert.equal(seen[2].form.get('language'), 'en', 'falls back to WHISPER_LANGUAGE');
});

// ── OpenAI-compatible ────────────────────────────────────────────────────────

test('openai: /audio/transcriptions with bearer, model, both granularities; verbose_json parsed', async () => {
  useOpenAI({ STT_BASE_URL: ` ${BASE}/v1/ `, STT_MODEL: 'mistralai/Voxtral-Mini-3B-2507', STT_API_KEY: 'sk-test', STT_LANGUAGE: 'de' });
  process.env.WHISPER_TEMPERATURE = '0';
  reply = () => ({
    json: {
      task: 'transcribe', language: 'german', duration: 2.0,
      text: 'Hallo, Welt! Wie geht es?',
      segments: [
        { id: 0, start: 0, end: 1.0, text: 'Hallo, Welt!', no_speech_prob: 0.02 },
        { id: 1, start: 1.1, end: 2.0, text: 'Wie geht es?', no_speech_prob: 0.05 },
      ],
      words: [
        { word: 'Hallo', start: 0.0, end: 0.4 }, { word: 'Welt', start: 0.5, end: 0.9 },
        { word: 'Wie', start: 1.1, end: 1.3 }, { word: 'geht', start: 1.4, end: 1.6 }, { word: 'es', start: 1.7, end: 1.9 },
      ],
    },
  });
  const r = await transcribe(wavOfSeconds(2), { prompt: 'Vorher.' });

  assert.equal(seen[0].url, '/v1/audio/transcriptions');
  assert.equal(seen[0].auth, 'Bearer sk-test');
  const f = seen[0].form;
  assert.equal(f.get('file').name, 'audio.wav');
  assert.equal(f.get('model'), 'mistralai/Voxtral-Mini-3B-2507');
  assert.equal(f.get('language'), 'de');
  assert.equal(f.get('prompt'), 'Vorher.');
  assert.equal(f.get('temperature'), '0');
  assert.equal(f.get('response_format'), 'verbose_json');
  assert.deepEqual(f.getAll('timestamp_granularities[]'), ['word', 'segment']);

  assert.equal(r.text, 'Hallo, Welt! Wie geht es?');
  assert.equal(r.meta.provider, 'openai');
  assert.equal(r.meta.model, 'mistralai/Voxtral-Mini-3B-2507');
  assert.equal(r.meta.language, 'german');
  assert.equal(r.meta.segmentCount, 2);
  assert.equal(r.meta.noSpeechProbMax, 0.05);
  assert.equal(r.meta.wordCount, 5);
  // Whole words → leading-space convention + punctuation re-attached from text.
  assert.deepEqual(r.words.map((w) => w.w), ['Hallo,', 'Welt!', 'Wie', 'geht', 'es?']);
  assert.ok(r.words.every((w) => w.raw === ` ${w.w}`));
  assert.deepEqual(mergeTokensToWords(r.words).map((w) => w.text), ['Hallo,', 'Welt!', 'Wie', 'geht', 'es?']);
});

test('openai: empty STT_MODEL / no key / word timestamps off → fields and header omitted', async () => {
  useOpenAI();
  process.env.WHISPER_WORD_TIMESTAMPS = 'false';
  reply = () => ({ json: { text: 'ok' } });
  await transcribe(wavOfSeconds(0.2));
  assert.equal(seen[0].auth, null);
  assert.equal(seen[0].form.get('model'), null);
  assert.equal(seen[0].form.get('language'), null, 'no language configured → auto');
  assert.deepEqual(seen[0].form.getAll('timestamp_granularities[]'), ['segment']);
});

test('openai: {text}-only reply (server ignores verbose_json)', async () => {
  useOpenAI();
  reply = () => ({ json: { text: ' Nur Text, keine Zeiten. ' } });
  const r = await transcribe(wavOfSeconds(1));
  assert.equal(r.text, 'Nur Text, keine Zeiten.');
  assert.equal(r.words, null);
  assert.equal(r.meta.segmentCount, 0);
  assert.equal(r.meta.noSpeechProbAvg, null);
  assert.equal(r.meta.provider, 'openai');
});

test('openai: text/plain and bare-JSON-string replies', async () => {
  useOpenAI();
  reply = () => ({ text: 'Einfach nur Text.\n' });
  assert.equal((await transcribe(wavOfSeconds(1))).text, 'Einfach nur Text.');
  reply = () => ({ json: 'Als JSON-String.' });
  assert.equal((await transcribe(wavOfSeconds(1))).text, 'Als JSON-String.');
  reply = () => ({ text: 'Ohne Content-Type', type: '' });
  assert.equal((await transcribe(wavOfSeconds(1))).text, 'Ohne Content-Type');
});

test('openai: whisper.cpp behind /v1 (token-style words) keeps the token convention', async () => {
  useOpenAI();
  reply = () => ({
    json: {
      text: ' Quantengravitation ist',
      segments: [{ text: ' Quantengravitation ist', no_speech_prob: 0.01, words: [
        { word: ' Quant', start: 0, end: 0.3 }, { word: 'eng', start: 0.3, end: 0.5 },
        { word: 'ravitation', start: 0.5, end: 1.0 }, { word: ' ist', start: 1.1, end: 1.3 }] }],
    },
  });
  const r = await transcribe(wavOfSeconds(1.5));
  assert.deepEqual(r.words.map((w) => w.raw), [' Quant', 'eng', 'ravitation', ' ist']);
  assert.deepEqual(mergeTokensToWords(r.words).map((w) => w.text), ['Quantengravitation', 'ist']);
});

test('openai: verbose_json rejected (HTTP 400) → retried once as json, downgrade remembered per server', async () => {
  useOpenAI({ STT_MODEL: 'old-vllm' });
  reply = (_req, form) => (form.get('response_format') === 'verbose_json'
    ? { status: 400, json: { message: 'Currently only support response_format `text` or `json`' } }
    : { json: { text: 'Fallback.' } });
  const r = await transcribe(wavOfSeconds(1));
  assert.equal(r.text, 'Fallback.');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].form.get('response_format'), 'json');
  assert.deepEqual(seen[1].form.getAll('timestamp_granularities[]'), []);

  await transcribe(wavOfSeconds(1));
  assert.equal(seen.length, 3, 'no second failed round trip');
  assert.equal(seen[2].form.get('response_format'), 'json');

  // Another model on the same server is probed afresh.
  process.env.STT_MODEL = 'new-model';
  await transcribe(wavOfSeconds(1));
  assert.equal(seen[3].form.get('response_format'), 'verbose_json');
});

test('openai: auth/server errors are not retried', async () => {
  useOpenAI({ STT_API_KEY: 'wrong' });
  reply = () => ({ status: 401, json: { error: 'invalid key' } });
  await assert.rejects(() => transcribe(wavOfSeconds(0.2)), /^Error: stt: HTTP 401 \(http:\/\/127\.0\.0\.1:\d+\/v1\/audio\/transcriptions\): .*invalid key/);
  assert.equal(seen.length, 1);
});

// ── Errors ───────────────────────────────────────────────────────────────────

test('errors: HTTP status, connection failure, missing base URL, invalid JSON', async () => {
  process.env.WHISPER_URL = BASE;
  reply = () => ({ status: 500, text: 'boom' });
  await assert.rejects(() => transcribe(wavOfSeconds(0.2)), /stt: HTTP 500 \(http:\/\/127\.0\.0\.1:\d+\/inference\): boom/);

  process.env.WHISPER_URL = 'http://127.0.0.1:1';
  await assert.rejects(() => transcribe(wavOfSeconds(0.2)), /stt: connection failed \(http:\/\/127\.0\.0\.1:1\/inference\)/);

  process.env.STT_PROVIDER = 'openai';
  await assert.rejects(() => transcribe(wavOfSeconds(0.2)), /stt: STT_PROVIDER=openai but STT_BASE_URL is empty/);

  process.env.STT_BASE_URL = BASE;
  reply = () => ({ text: '{kaputt', type: 'application/json' });
  await assert.rejects(() => transcribe(wavOfSeconds(0.2)), /stt: invalid JSON from http:\/\/127\.0\.0\.1:\d+\/audio\/transcriptions/);
});

test('timeout: STT_TIMEOUT_MS covers a slow server and a stalled body', async () => {
  process.env.WHISPER_URL = BASE;
  process.env.STT_TIMEOUT_MS = '80';
  reply = () => ({ json: { text: 'zu spät' }, delayMs: 400 });
  await assert.rejects(() => transcribe(wavOfSeconds(0.2)), /stt: timeout after 80 ms \(http:\/\/127\.0\.0\.1:\d+\/inference\)/);

  useOpenAI({ STT_TIMEOUT_MS: '80' });
  reply = () => ({ json: { text: 'Kopf da, Rest hängt' }, stallBodyMs: 400 });
  await assert.rejects(() => transcribe(wavOfSeconds(0.2)), /stt: timeout after 80 ms/);
});

test('caller abort is re-thrown as AbortError, not wrapped as failure', async () => {
  process.env.WHISPER_URL = BASE;
  reply = () => ({ json: { text: 'x' }, delayMs: 300 });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(() => transcribe(wavOfSeconds(0.2), { signal: ctrl.signal }), (e) => e.name === 'AbortError');
});

// ── Runtime switch / config ──────────────────────────────────────────────────

test('provider switches at runtime via env (settings panel), no restart', async () => {
  process.env.WHISPER_URL = BASE;
  reply = (req) => ({ json: { text: req.url } });
  assert.equal((await transcribe(wavOfSeconds(0.2))).text, '/inference');
  process.env.STT_PROVIDER = 'OpenAI';
  process.env.STT_BASE_URL = `${BASE}/v1`;
  assert.equal(sttProvider(), 'openai');
  assert.equal((await transcribe(wavOfSeconds(0.2))).text, '/v1/audio/transcriptions');
  process.env.STT_PROVIDER = 'whispercpp';
  assert.equal((await transcribe(wavOfSeconds(0.2))).text, '/inference');
  process.env.STT_PROVIDER = 'something-else';
  assert.equal(sttProvider(), 'whispercpp', 'unknown value → default');
});

test('sttConfig: effective values, never the API key', () => {
  assert.deepEqual(sttConfig(), {
    provider: 'whisper.cpp', language: 'auto', temperature: 0.2, wordTimestamps: true,
    timeoutMs: 120000, url: 'http://localhost:8080',
  });
  useOpenAI({ STT_MODEL: 'whisper-large-v3', STT_API_KEY: 'sk-geheim', STT_LANGUAGE: 'de', STT_TIMEOUT_MS: '0' });
  const c = sttConfig();
  assert.deepEqual(c, {
    provider: 'openai', language: 'de', temperature: 0.2, wordTimestamps: true, timeoutMs: 0,
    url: `${BASE}/v1`, model: 'whisper-large-v3', apiKeySet: true,
  });
  assert.ok(!JSON.stringify(c).includes('sk-geheim'));
  process.env.STT_TIMEOUT_MS = 'abc';
  assert.equal(sttConfig().timeoutMs, 120000, 'garbage → default');
});

// ── Word normalisation → streaming / chunked / finalize ──────────────────────

test('normalizeWordList: whole words get the new-word marker; token lists stay untouched', () => {
  const whole = parseWords({ words: [{ word: 'Stop', start: 0, end: 0.3 }, { word: 'abbrechen', start: 0.4, end: 0.9 }] });
  // The bug this guards against: without normalisation the second word reads
  // as a sub-word continuation and is glued onto the first.
  assert.deepEqual(mergeTokensToWords(whole).map((w) => w.text), ['Stopabbrechen']);
  const fixed = normalizeWordList(whole, 'Stop! Abbrechen.');
  assert.deepEqual(mergeTokensToWords(fixed).map((w) => w.text), ['Stop!', 'Abbrechen.']);

  const tokens = parseWords({ words: [{ word: ' Ab', start: 0, end: 0.2 }, { word: 'brechen', start: 0.2, end: 0.5 }] });
  assert.equal(normalizeWordList(tokens, 'Abbrechen'), tokens);

  // Text the word list doesn't line up with: bare words, still separate.
  const odd = normalizeWordList(parseWords({ words: [{ word: 'eins', start: 0 }, { word: 'zwei', start: 1 }] }), 'ganz anders');
  assert.deepEqual(odd.map((w) => w.raw), [' eins', ' zwei']);
  // Skipped text tokens (e.g. a filler the word list dropped) are stepped over.
  const skip = normalizeWordList(parseWords({ words: [{ word: 'Ja', start: 0 }, { word: 'genau', start: 1 }] }), 'Ja, äh, genau.');
  assert.deepEqual(skip.map((w) => w.w), ['Ja,', 'genau.']);
});

test('streaming over an OpenAI word-level provider: agreement, sentence trim and finalize words are correct', async () => {
  useOpenAI({ STT_STREAM_MIN_WINDOW_MS: '500', STT_STREAM_TRIM_SECONDS: '5', STT_STREAM_PROMPT: 'true' });
  const w = (word, start, end) => ({ word, start, end });
  const first = {
    text: 'Das ist ein Satz. Und mehr',
    words: [w('Das', 0.2, 0.5), w('ist', 0.6, 0.9), w('ein', 1.0, 1.3), w('Satz', 1.4, 5.4), w('Und', 6.0, 6.3), w('mehr', 6.4, 6.8)],
  };
  // Final pass over the trimmed window (cut at (5.4+6.0)/2 = 5.7 s).
  const final = {
    text: 'Und mehr Text.',
    words: [w('Und', 0.3, 0.6), w('mehr', 0.7, 1.1), w('Text', 1.3, 1.7)],
  };
  reply = (_req, _form, n) => ({ json: n <= 2 ? first : final });

  const s = createSttStream();
  const r1 = await s.tick(pcmOfSeconds(7));
  assert.equal(r1.text, 'Das ist ein Satz. Und mehr', 'words stay separate and punctuated');
  assert.equal(r1.stableWords, 0);
  const r2 = await s.tick(pcmOfSeconds(8));
  assert.equal(r2.stableWords, 6);
  // The sentence end was found (punctuation re-attached) → window trimmed and
  // the first sentence locked as its own paragraph.
  assert.deepEqual(r2.segments, ['Das ist ein Satz.', 'Und mehr']);
  assert.equal(s.state.lockedGroups.length, 1);

  const fin = await s.finalize(pcmOfSeconds(9));
  assert.equal(fin.text, 'Das ist ein Satz. Und mehr Text.');
  assert.deepEqual(fin.segments, ['Das ist ein Satz.', 'Und mehr Text.']);
  assert.deepEqual(fin.words.map((x) => x.w), ['Das', 'ist', 'ein', 'Satz.', 'Und', 'mehr', 'Text.']);
  assert.ok(fin.words[6].t0 >= 6900, `tail offset by the trimmed window: ${fin.words[6].t0}`);
  assert.equal(fin.stt.provider, 'openai');
  // The streamer's context prompt reaches the server.
  assert.equal(seen[2].form.get('prompt'), 'Das ist ein Satz.');
});

test('chunked + finalize re-STT over an OpenAI word-level provider: whole display words, ms offsets', async () => {
  useOpenAI();
  reply = () => ({
    json: {
      text: 'Hallo Rabenauge, wer ist Kelthur?',
      segments: [{ text: 'Hallo Rabenauge, wer ist Kelthur?', no_speech_prob: 0.1 }],
      words: [{ word: 'Hallo', start: 0.1, end: 0.4 }, { word: 'Rabenauge', start: 0.5, end: 1.0 },
        { word: 'wer', start: 1.2, end: 1.4 }, { word: 'ist', start: 1.5, end: 1.6 }, { word: 'Kelthur', start: 1.7, end: 2.2 }],
    },
  });
  const r = await transcribeChunked(pcmOfSeconds(2.5));
  assert.deepEqual(r.transcripts, ['Hallo Rabenauge, wer ist Kelthur?']);
  assert.deepEqual(r.words.map((x) => x.w), ['Hallo', 'Rabenauge,', 'wer', 'ist', 'Kelthur?']);
  assert.deepEqual(r.words[1], { w: 'Rabenauge,', t0: 500, t1: 1000 });
  assert.equal(r.stt.provider, 'openai');
  assert.equal(r.stt.noSpeechProbAvg, 0.1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-final-'));
  try {
    const file = path.join(dir, 'u.wav');
    fs.writeFileSync(file, pcmToWav(pcmOfSeconds(2.5)));
    const fin = await transcribeWavFile(file);
    assert.equal(fin.text, 'Hallo Rabenauge, wer ist Kelthur?');
    assert.equal(fin.words.length, 5);
    assert.equal(seen.at(-1).form.get('file').size, 44 + 2.5 * SR * 2, 'finalize sends the whole utterance WAV');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanWhisperText is still exported from stt.js (compat)', () => {
  assert.equal(cleanWhisperText('befind\nliche'), 'befindliche');
});
