import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { synthesizeStream, ttsConfig, ttsProvider, wavDecoder, pcmDecoder } from '../src/providers/tts.js';
import { synthesizeStream as reExported } from '../src/tts.js';
import { registerDebugTtsRoute } from '../src/debugTts.js';

// One fake server for all three dialects (Piper /tts/synthesize, OpenAI
// /v1/audio/speech, ElevenLabs /v1/text-to-speech/:voice/stream). Each test
// installs `handler(req, res, body)`; every request is recorded in `seen`,
// including whether the client hung up (`closed`).
const seen = [];
let handler = null;
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const entry = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null, closed: false };
    seen.push(entry);
    res.on('close', () => { entry.closed = true; });
    handler(req, res, entry.body);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.closeAllConnections(); srv.close(); });

const KEYS = ['TTS_PROVIDER', 'TTS_URL', 'TTS_BASE_URL', 'TTS_MODEL', 'TTS_VOICE', 'TTS_API_KEY', 'TTS_SPEED',
  'TTS_RESPONSE_FORMAT', 'TTS_SAMPLE_RATE', 'TTS_TIMEOUT_MS', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_BASE_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  seen.length = 0;
  handler = (req, res) => { res.writeHead(500); res.end('no handler'); };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Distinct, non-symmetric sample values: a one-byte shift anywhere would
// change them all.
function ramp(n, seed = 0) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(((i + seed) * 37) % 30000 - 15000, i * 2);
  return b;
}

// Write `chunks` with small gaps so they reach the client as separate reads.
async function sendChunks(res, headers, chunks, gapMs = 4) {
  res.writeHead(200, headers);
  for (const c of chunks) {
    res.write(c);
    await sleep(gapMs);
  }
  res.end();
}

function splitAt(buf, sizes) {
  const out = [];
  let off = 0;
  for (let k = 0; off < buf.length; k++) {
    const n = Math.min(sizes[k % sizes.length], buf.length - off);
    out.push(buf.subarray(off, off + n));
    off += n;
  }
  return out;
}

async function collect(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  for (const c of chunks) {
    assert.ok(Buffer.isBuffer(c.pcm), 'pcm is a Buffer');
    assert.ok(c.pcm.length > 0 && c.pcm.length % 2 === 0, `chunk of ${c.pcm.length} bytes is not whole samples`);
  }
  return { chunks, pcm: Buffer.concat(chunks.map((c) => c.pcm)), rates: [...new Set(chunks.map((c) => c.sampleRate))] };
}

// Minimal RIFF builder. `pre` chunks go before fmt, `mid` between fmt and data.
function riffChunk(id, payload) {
  const h = Buffer.alloc(8);
  h.write(id, 0, 'latin1');
  h.writeUInt32LE(payload.length, 4);
  return Buffer.concat([h, payload, Buffer.alloc(payload.length & 1)]);
}
function wav({ rate = 24000, channels = 1, bits = 16, format = 1, extensible = false, data, dataSize, pre = [], mid = [], post = [] }) {
  let fmt;
  if (extensible) {
    fmt = Buffer.alloc(40);
    fmt.writeUInt16LE(0xFFFE, 0);
    fmt.writeUInt16LE(22, 16);          // cbSize
    fmt.writeUInt16LE(bits, 18);        // valid bits
    fmt.writeUInt16LE(format, 24);      // SubFormat GUID starts with the real code
  } else {
    fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(format, 0);
  }
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * bits / 8, 8);
  fmt.writeUInt16LE(channels * bits / 8, 12);
  fmt.writeUInt16LE(bits, 14);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0, 'latin1');
  dataHdr.writeUInt32LE(dataSize ?? data.length, 4);
  const riff = Buffer.from('RIFF\xff\xff\xff\xffWAVE', 'latin1');
  return Buffer.concat([riff, ...pre, riffChunk('fmt ', fmt), ...mid, dataHdr, data, ...post]);
}

function stereo(left, right) {
  const n = left.length / 2;
  const b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(left.readInt16LE(i * 2), i * 4);
    b.writeInt16LE(right.readInt16LE(i * 2), i * 4 + 2);
  }
  return b;
}

function mono(left, right) {
  const n = left.length / 2;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((left.readInt16LE(i * 2) + right.readInt16LE(i * 2)) / 2), i * 2);
  return b;
}

// Feed a decoder a sequence of chunks, return the concatenated mono PCM.
function decodeAll(decoder, chunks) {
  const out = [];
  for (const c of chunks) out.push(...decoder.push(Buffer.from(c)));
  out.push(...decoder.end());
  for (const o of out) assert.equal(o.pcm.length % 2, 0);
  return { pcm: Buffer.concat(out.map((o) => o.pcm)), rates: [...new Set(out.map((o) => o.sampleRate))] };
}

// ── Piper ────────────────────────────────────────────────────────────────────

test('piper (default): same request as before the refactor, rate from X-Sample-Rate, odd chunk boundaries realigned', async () => {
  process.env.TTS_URL = `${BASE}/`;
  const pcm = ramp(3000);
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'audio/pcm-s16le', 'X-Sample-Rate': '16000' }, splitAt(pcm, [1, 3, 1001, 2, 5]));
  const r = await collect(synthesizeStream('Hallo Welt', {}, undefined));
  assert.equal(seen[0].url, '/tts/synthesize');
  assert.deepEqual(seen[0].body, {
    text: 'Hallo Welt', model: 'emotional', speaker_id: 4, length_scale: 1, noise_scale: 0.667, noise_w_scale: 0.8,
  });
  assert.deepEqual(r.rates, [16000]);
  assert.ok(r.pcm.equals(pcm), 'every byte arrives, in order, sample-aligned');

  handler = (req, res) => sendChunks(res, {}, [pcm.subarray(0, 100)]);
  const r2 = await collect(synthesizeStream('x', { model: 'high', speakerId: 7, lengthScale: 1.3, noiseScale: 0.5, noiseWScale: 0.6 }));
  assert.deepEqual(seen[1].body, { text: 'x', model: 'high', speaker_id: 7, length_scale: 1.3, noise_scale: 0.5, noise_w_scale: 0.6 });
  assert.deepEqual(r2.rates, [22050], 'missing X-Sample-Rate → 22050 as before');
  assert.equal(reExported, synthesizeStream, 'src/tts.js re-exports the provider');
});

test('piper: HTTP errors and connection failures carry provider, status, URL and body', async () => {
  process.env.TTS_URL = BASE;
  handler = (req, res) => { res.writeHead(500); res.end('voice not loaded'); };
  await assert.rejects(collect(synthesizeStream('x')), /^Error: tts \(piper\): HTTP 500 \(http:\/\/127\.0\.0\.1:\d+\/tts\/synthesize\): voice not loaded$/);
  process.env.TTS_URL = 'http://127.0.0.1:9'; // discard port — nothing listens
  await assert.rejects(collect(synthesizeStream('x')), /tts \(piper\): connection failed \(http:\/\/127\.0\.0\.1:9\/tts\/synthesize\)/);
});

// ── ElevenLabs ───────────────────────────────────────────────────────────────

test('elevenlabs: same request as before (overridable base URL), 24 kHz PCM', async () => {
  process.env.TTS_PROVIDER = 'elevenlabs';
  process.env.ELEVENLABS_BASE_URL = `${BASE}/`;
  process.env.ELEVENLABS_API_KEY = 'xi-secret';
  const pcm = ramp(2400);
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'audio/pcm' }, splitAt(pcm, [777, 1, 2]));
  const r = await collect(synthesizeStream('Hallo', { model: 'high', speakerId: 1 }));
  assert.equal(seen[0].url, '/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/stream?output_format=pcm_24000');
  assert.equal(seen[0].headers['xi-api-key'], 'xi-secret');
  assert.equal(seen[0].headers.authorization, undefined);
  assert.deepEqual(seen[0].body, {
    text: 'Hallo', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.5 },
  });
  assert.deepEqual(r.rates, [24000]);
  assert.ok(r.pcm.equals(pcm));

  process.env.ELEVENLABS_VOICE_ID = 'voice-42';
  handler = (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"detail":"invalid_api_key"}'); };
  await assert.rejects(collect(synthesizeStream('x')), /tts \(elevenlabs\): HTTP 401 .*\/v1\/text-to-speech\/voice-42\/stream.*invalid_api_key/);

  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(collect(synthesizeStream('x')), /tts: ELEVENLABS_API_KEY not set/);
});

// ── OpenAI-compatible ────────────────────────────────────────────────────────

test('openai pcm: /audio/speech on TTS_BASE_URL with bearer, model/voice/format, raw PCM at TTS_SAMPLE_RATE', async () => {
  process.env.TTS_PROVIDER = 'OpenAI';
  process.env.TTS_BASE_URL = ` ${BASE}/v1/ `;
  process.env.TTS_MODEL = 'qwen3-tts';
  process.env.TTS_VOICE = 'Vivian';
  process.env.TTS_API_KEY = 'sk-test';
  const pcm = ramp(4800);
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'audio/pcm' }, splitAt(pcm, [4097, 3, 1]));
  const r = await collect(synthesizeStream('Guten Tag', { model: 'emotional', speakerId: 3 }));
  assert.equal(seen[0].url, '/v1/audio/speech');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-test');
  assert.deepEqual(seen[0].body, { input: 'Guten Tag', response_format: 'pcm', model: 'qwen3-tts', voice: 'Vivian' },
    'Piper opts (model "emotional", speaker) are not leaked; no speed field by default');
  assert.deepEqual(r.rates, [24000]);
  assert.ok(r.pcm.equals(pcm));

  // Rate override, empty model/voice omitted, no key → no auth header.
  process.env.TTS_SAMPLE_RATE = '22050';
  delete process.env.TTS_MODEL;
  process.env.TTS_VOICE = '  ';
  delete process.env.TTS_API_KEY;
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'application/octet-stream' }, [pcm.subarray(0, 200)]);
  const r2 = await collect(synthesizeStream('x'));
  assert.deepEqual(seen[1].body, { input: 'x', response_format: 'pcm' });
  assert.equal(seen[1].headers.authorization, undefined);
  assert.deepEqual(r2.rates, [22050]);
});

test('openai: speed = TTS_SPEED / Piper lengthScale, clamped to 0.25–4, omitted at 1', async () => {
  process.env.TTS_PROVIDER = 'openai';
  process.env.TTS_BASE_URL = BASE;
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'audio/pcm' }, [ramp(10)]);
  const speedFor = async (opts) => { seen.length = 0; await collect(synthesizeStream('x', opts)); return seen[0].body.speed; };
  assert.equal(await speedFor({}), undefined);
  assert.equal(await speedFor({ lengthScale: 2 }), 0.5);
  process.env.TTS_SPEED = '1.25';
  assert.equal(await speedFor({}), 1.25);
  assert.equal(await speedFor({ lengthScale: 1.25 }), undefined, '1.25 / 1.25 = 1 → omitted');
  process.env.TTS_SPEED = '9';
  assert.equal(await speedFor({}), 4);
  assert.equal(ttsConfig().speed, 4);
});

test('openai wav: header split byte by byte, chunks before/after fmt skipped, stereo downmixed, rate from header', async () => {
  process.env.TTS_PROVIDER = 'openai';
  process.env.TTS_BASE_URL = `${BASE}/v1`;
  process.env.TTS_RESPONSE_FORMAT = 'wav';
  const left = ramp(1500);
  const right = ramp(1500, 777);
  const body = wav({
    rate: 22050, channels: 2, data: stereo(left, right), dataSize: 0xFFFFFFFF, // streaming placeholder
    pre: [riffChunk('JUNK', Buffer.from('odd!!'))],                            // odd size → pad byte
    mid: [riffChunk('LIST', Buffer.alloc(27, 7)), riffChunk('fact', Buffer.alloc(4))],
  });
  const headerLen = body.length - left.length * 2;
  // Header one byte per write, then data at odd offsets (splits inside a stereo frame).
  const chunks = [...splitAt(body.subarray(0, headerLen), [1]), ...splitAt(body.subarray(headerLen), [3, 1, 4093, 2, 7])];
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'audio/wav' }, chunks, 1);
  const r = await collect(synthesizeStream('x'));
  assert.equal(seen[0].body.response_format, 'wav');
  assert.deepEqual(r.rates, [22050]);
  assert.ok(r.pcm.equals(mono(left, right)), 'stereo → mono average, no byte shift');
});

test('wav parser: every single split point of a full WAV gives the same audio (decoder level)', () => {
  const data = ramp(64);
  const body = wav({
    rate: 16000, channels: 1, data,
    pre: [riffChunk('LIST', Buffer.alloc(3, 1))],
    mid: [riffChunk('JUNK', Buffer.alloc(9, 2))],
    post: [riffChunk('LIST', Buffer.from('trailing metadata, not audio'))],
  });
  for (let a = 1; a < body.length; a++) {
    const { pcm, rates } = decodeAll(wavDecoder('t'), [body.subarray(0, a), body.subarray(a)]);
    assert.ok(pcm.equals(data), `split at ${a}`);
    assert.deepEqual(rates, [16000]);
  }
  // Three-way splits around the header/data boundary, stereo + extensible.
  const left = ramp(32);
  const right = ramp(32, 5);
  const st = wav({ rate: 48000, channels: 2, extensible: true, data: stereo(left, right) });
  for (let a = 1; a < 80; a++) {
    for (let b = a + 1; b < 90; b += 3) {
      const { pcm } = decodeAll(wavDecoder('t'), [st.subarray(0, a), st.subarray(a, b), st.subarray(b)]);
      assert.ok(pcm.equals(mono(left, right)), `split at ${a}/${b}`);
    }
  }
});

test('wav parser: back-to-back WAV files are followed; format errors are explicit', () => {
  const a = ramp(50);
  const b = ramp(70, 3);
  const two = Buffer.concat([wav({ rate: 24000, data: a }), wav({ rate: 24000, data: b })]);
  assert.ok(decodeAll(wavDecoder('t'), splitAt(two, [13])).pcm.equals(Buffer.concat([a, b])));

  const changed = Buffer.concat([wav({ rate: 24000, data: a }), wav({ rate: 16000, data: b })]);
  assert.throws(() => decodeAll(wavDecoder('t'), [changed]), /WAV format changed mid-stream/);
  assert.throws(() => decodeAll(wavDecoder('t'), [wav({ format: 3, bits: 32, data: Buffer.alloc(8) })]), /t: unsupported WAV encoding \(format 3, 32 bit\) — only 16-bit integer PCM/);
  assert.throws(() => decodeAll(wavDecoder('t'), [wav({ bits: 24, data: Buffer.alloc(6) })]), /format 1, 24 bit/);
  assert.throws(() => decodeAll(wavDecoder('t'), [Buffer.from('RIFF\0\0\0\0WAVEdata\x04\0\0\0abcd', 'latin1')]), /data chunk before fmt/);
  assert.throws(() => decodeAll(wavDecoder('t'), [Buffer.from('RIFX\0\0\0\0WAVE', 'latin1')]), /not a RIFF\/WAVE file/);
  assert.throws(() => decodeAll(wavDecoder('t'), [wav({ data: a }).subarray(0, 30)]), /ended before any WAV audio data/);
});

test('pcm decoder: arbitrary byte splits never shift samples; a dangling byte at the end is dropped', () => {
  const data = ramp(40);
  for (let a = 1; a < data.length; a++) {
    for (const b of [a + 1, a + 2, a + 3]) {
      if (b >= data.length) continue;
      const { pcm } = decodeAll(pcmDecoder(24000), [data.subarray(0, a), data.subarray(a, b), data.subarray(b)]);
      assert.ok(pcm.equals(data), `split ${a}/${b}`);
    }
  }
  const { pcm } = decodeAll(pcmDecoder(24000), [Buffer.concat([data, Buffer.from([0x42])])]);
  assert.ok(pcm.equals(data));
});

test('openai: a RIFF body is parsed as WAV even when pcm was asked for and Content-Type is generic', async () => {
  process.env.TTS_PROVIDER = 'openai';
  process.env.TTS_BASE_URL = BASE;
  const data = ramp(1000);
  const body = wav({ rate: 44100, data });
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'application/octet-stream' }, splitAt(body, [2, 1, 1, 9, 5000]));
  const r = await collect(synthesizeStream('x'));
  assert.deepEqual(r.rates, [44100]);
  assert.ok(r.pcm.equals(data));
});

test('openai: compressed or non-audio replies fail with a hint instead of playing noise', async () => {
  process.env.TTS_PROVIDER = 'openai';
  process.env.TTS_BASE_URL = BASE;
  for (const ctype of ['audio/ogg; codecs=opus', 'audio/mpeg', 'audio/opus', 'audio/aac', 'audio/flac']) {
    handler = (req, res) => sendChunks(res, { 'Content-Type': ctype }, [Buffer.from('whatever')]);
    await assert.rejects(collect(synthesizeStream('x')),
      /tts \(openai\): server replied with compressed audio .* set TTS_RESPONSE_FORMAT=pcm or wav/, ctype);
  }
  for (const [magic, name] of [['OggS\0\x02', 'Ogg/Opus'], ['ID3\x04\0\0', 'MP3'], ['fLaC\0\0', 'FLAC']]) {
    handler = (req, res) => sendChunks(res, { 'Content-Type': 'application/octet-stream' }, splitAt(Buffer.from(magic, 'latin1'), [1]));
    await assert.rejects(collect(synthesizeStream('x')), new RegExp(`replied with ${name} audio`));
  }
  handler = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"error":"voice not found"}'); };
  await assert.rejects(collect(synthesizeStream('x')), /tts \(openai\): expected audio, got application\/json .*voice not found/);
  handler = (req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"detail":"model qwen not found"}'); };
  await assert.rejects(collect(synthesizeStream('x')), /tts \(openai\): HTTP 404 .*\/audio\/speech.*model qwen not found/);

  process.env.TTS_RESPONSE_FORMAT = 'mp3';
  seen.length = 0;
  await assert.rejects(collect(synthesizeStream('x')), /TTS_RESPONSE_FORMAT=mp3 is not supported — set pcm or wav/);
  assert.equal(seen.length, 0, 'refused before any request');
  delete process.env.TTS_RESPONSE_FORMAT;
  delete process.env.TTS_BASE_URL;
  await assert.rejects(collect(synthesizeStream('x')), /TTS_PROVIDER=openai but TTS_BASE_URL is empty/);
});

// ── Abort (barge-in) ─────────────────────────────────────────────────────────

const PROVIDER_ENV = {
  piper: () => { process.env.TTS_URL = BASE; },
  openai: () => { process.env.TTS_PROVIDER = 'openai'; process.env.TTS_BASE_URL = BASE; },
  elevenlabs: () => { process.env.TTS_PROVIDER = 'elevenlabs'; process.env.ELEVENLABS_BASE_URL = BASE; process.env.ELEVENLABS_API_KEY = 'k'; },
};

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  return cond();
}

test('abort mid-stream ends the generator silently and releases the connection — every provider', async () => {
  for (const [name, setup] of Object.entries(PROVIDER_ENV)) {
    for (const k of KEYS) delete process.env[k];
    setup();
    seen.length = 0;
    // First chunk, then the server keeps the response open forever.
    handler = (req, res) => { res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' }); res.write(ramp(100)); };
    const ctrl = new AbortController();
    const it = synthesizeStream('x', {}, ctrl.signal)[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.done, false, name);
    setTimeout(() => ctrl.abort(), 20);
    assert.deepEqual(await it.next(), { value: undefined, done: true }, `${name}: silent end, no error`);
    assert.ok(await waitFor(() => seen[0].closed), `${name}: server saw the client hang up`);
  }
});

test('abort before the response headers, and an already aborted signal, end silently', async () => {
  for (const [name, setup] of Object.entries(PROVIDER_ENV)) {
    for (const k of KEYS) delete process.env[k];
    setup();
    seen.length = 0;
    handler = () => {}; // never answers
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const r = await collect(synthesizeStream('x', {}, ctrl.signal));
    assert.equal(r.chunks.length, 0, name);

    const pre = new AbortController();
    pre.abort();
    seen.length = 0;
    assert.equal((await collect(synthesizeStream('x', {}, pre.signal))).chunks.length, 0, name);
    assert.equal(seen.length, 0, `${name}: no request for an aborted signal`);
  }
});

test('consumer break stops the stream and releases the connection', async () => {
  process.env.TTS_URL = BASE;
  handler = (req, res) => { res.writeHead(200); res.write(ramp(100)); };
  for await (const c of synthesizeStream('x')) { assert.ok(c.pcm.length); break; }
  assert.ok(await waitFor(() => seen[0].closed));
});

// ── Timeouts ─────────────────────────────────────────────────────────────────

test('header timeout: no response within TTS_TIMEOUT_MS → error, not a hang', async () => {
  process.env.TTS_URL = BASE;
  process.env.TTS_TIMEOUT_MS = '80';
  handler = () => {}; // accepts the request, never answers
  const t0 = Date.now();
  await assert.rejects(collect(synthesizeStream('x')), /^Error: tts \(piper\): timeout after 80 ms \(http:\/\/127\.0\.0\.1:\d+\/tts\/synthesize\)$/);
  assert.ok(Date.now() - t0 < 2000);
});

test('idle timeout: a stream that stalls mid-sentence ends with an error after the chunks it did deliver', async () => {
  process.env.TTS_PROVIDER = 'openai';
  process.env.TTS_BASE_URL = BASE;
  process.env.TTS_TIMEOUT_MS = '100';
  handler = (req, res) => { res.writeHead(200, { 'Content-Type': 'audio/pcm' }); res.write(ramp(100)); };
  const got = [];
  await assert.rejects(async () => { for await (const c of synthesizeStream('x')) got.push(c); },
    /tts \(openai\): stream stalled — no audio data for 100 ms \(http:\/\/127\.0\.0\.1:\d+\/audio\/speech\)/);
  assert.equal(got.length, 1, 'the delivered audio was yielded before the error');
  assert.ok(await waitFor(() => seen[0].closed), 'stalled connection is closed');
});

test('timeout bounds gaps, not the total: a slow but steady stream and a slow consumer are fine', async () => {
  process.env.TTS_URL = BASE;
  process.env.TTS_TIMEOUT_MS = '120';
  const pcm = ramp(1000);
  // 8 chunks 60 ms apart = ~480 ms total, four times the timeout.
  handler = (req, res) => sendChunks(res, { 'X-Sample-Rate': '24000' }, splitAt(pcm, [250]), 60);
  assert.ok((await collect(synthesizeStream('x'))).pcm.equals(pcm));

  // Consumer spends 300 ms per chunk — that is not the server's fault.
  handler = (req, res) => sendChunks(res, { 'X-Sample-Rate': '24000' }, splitAt(pcm, [1000]), 5);
  const out = [];
  for await (const c of synthesizeStream('x')) { out.push(c.pcm); await sleep(300); }
  assert.ok(Buffer.concat(out).equals(pcm));

  process.env.TTS_TIMEOUT_MS = '0'; // 0 = off
  handler = (req, res) => setTimeout(() => sendChunks(res, {}, [pcm]), 150);
  assert.ok((await collect(synthesizeStream('x'))).pcm.equals(pcm));
});

// ── Runtime switch / config snapshot ─────────────────────────────────────────

test('provider is read per call: switching TTS_PROVIDER takes effect on the next synthesis', async () => {
  process.env.TTS_URL = BASE;
  process.env.TTS_BASE_URL = `${BASE}/v1`;
  process.env.ELEVENLABS_BASE_URL = BASE;
  process.env.ELEVENLABS_API_KEY = 'k';
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '22050' }, [ramp(10)]);
  const urls = [];
  for (const p of ['piper', 'openai', 'elevenlabs', 'nonsense', '']) {
    process.env.TTS_PROVIDER = p;
    seen.length = 0;
    await collect(synthesizeStream('x'));
    urls.push(seen[0].url.split('?')[0]);
  }
  assert.deepEqual(urls, ['/tts/synthesize', '/v1/audio/speech', '/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/stream', '/tts/synthesize', '/tts/synthesize']);
});

test('ttsConfig: effective settings per provider, never the API key', () => {
  assert.deepEqual(ttsConfig(), { provider: 'piper', url: 'http://localhost:5000', timeoutMs: 30000 });
  process.env.TTS_PROVIDER = 'openai';
  process.env.TTS_BASE_URL = 'http://gpu:8091/v1/';
  process.env.TTS_MODEL = 'm';
  process.env.TTS_API_KEY = 'sk-very-secret';
  process.env.TTS_TIMEOUT_MS = '5000';
  const c = ttsConfig();
  assert.deepEqual(c, {
    provider: 'openai', url: 'http://gpu:8091/v1', model: 'm', voice: null, responseFormat: 'pcm',
    sampleRate: 24000, speed: 1, apiKeySet: true, timeoutMs: 5000,
  });
  assert.ok(!JSON.stringify(c).includes('sk-very-secret'));
  process.env.TTS_RESPONSE_FORMAT = 'wav';
  assert.equal(ttsConfig().sampleRate, null, 'wav: rate comes from the header');
  process.env.TTS_PROVIDER = 'elevenlabs';
  process.env.ELEVENLABS_API_KEY = 'xi-very-secret';
  const e = ttsConfig();
  assert.equal(e.url, 'https://api.elevenlabs.io');
  assert.equal(e.apiKeySet, true);
  assert.ok(!JSON.stringify(e).includes('xi-very-secret'));
  assert.equal(ttsProvider(), 'elevenlabs');
});

// ── /debug/tts ───────────────────────────────────────────────────────────────

test('/debug/tts goes through the configured provider and keeps its frame-blob / 502 contract', async (t) => {
  const app = express();
  registerDebugTtsRoute(app);
  const dbg = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => dbg.close());
  const url = `http://127.0.0.1:${dbg.address().port}/debug/tts`;

  process.env.TTS_PROVIDER = 'openai';
  process.env.TTS_BASE_URL = BASE;
  const pcm = ramp(24000); // 1 s at 24 kHz → 50 frames of 20 ms
  handler = (req, res) => sendChunks(res, { 'Content-Type': 'audio/pcm' }, splitAt(pcm, [9999, 1]));
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  const blob = Buffer.from(await res.arrayBuffer());
  let frames = 0;
  for (let off = 0; off < blob.length; frames++) off += 4 + blob.readUInt32BE(off);
  assert.equal(frames, 50);
  assert.equal(seen[0].url, '/audio/speech');
  assert.match(seen[0].body.input, /Diagnose-Test der Sprachausgabe/);

  process.env.TTS_PROVIDER = 'piper';
  process.env.TTS_URL = BASE;
  seen.length = 0;
  handler = (req, res) => { res.writeHead(503); res.end('loading'); };
  const bad = await fetch(url);
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error, /tts \(piper\): HTTP 503 .*loading/);
  assert.deepEqual([seen[0].body.model, seen[0].body.speaker_id], ['emotional', 0], 'same Piper voice as before');
});
