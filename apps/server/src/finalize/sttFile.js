import fs from 'fs';
import { transcribeChunked } from '../pipeline.js';

// Extract raw PCM from a canonical PCM WAV by walking the RIFF chunks to the
// `data` chunk (the bot writes 48 kHz mono 16-bit via the `wav` package).
export function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    return buf; // not a WAV — return as-is, let STT fail loudly
  }
  let off = 12; // skip "RIFF"<size>"WAVE"
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  return buf.subarray(44); // fallback: assume a 44-byte header
}

// Re-transcribe a single utterance WAV → { text, words } where `words` are
// token timestamps in ms relative to the utterance start (or null). This is the
// authoritative finalize pass: complete audio, no transport gaps.
export async function transcribeWavFile(filePath) {
  const pcm = readWavPcm(filePath);
  const { transcripts, words } = await transcribeChunked(pcm);
  return { text: transcripts.join(' ').trim(), words: words ?? null };
}
