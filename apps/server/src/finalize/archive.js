import fs from 'fs';
import path from 'path';

// M4 thin slice: copy the verified utterance WAVs into <archiveDir>/audio/.
// M5 replaces this with an OGG/Opus 32 kbps encode (merged + per-speaker) and a
// configurable WAV retention/cleanup policy. Kept as its own module so the
// orchestrator contract (returns { files, ok, error }) stays stable.
export async function buildAudioArchive({ manifest, uploadDir, archiveDir, verified = null }) {
  const audioDir = path.join(archiveDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const files = [];
  for (const u of manifest.utterances || []) {
    if (verified && !verified.has(u.file)) continue;
    const src = path.join(uploadDir, u.file);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(audioDir, path.basename(u.file));
    fs.copyFileSync(src, dst);
    files.push(path.relative(archiveDir, dst));
  }
  return { files, ok: true, error: null, format: 'wav' };
}
