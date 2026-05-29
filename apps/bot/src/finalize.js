import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { log, warn, debug } from './logger.js';

// Build the finalize manifest the server needs: per-utterance WAV basenames
// with checksums + absolute-on-bot-clock timing derived from the session.
// sessionStartMs = session.startedAt (the wire sessionId); per-utterance
// startMs is relative to it (as recorded in the timeline).
export function buildManifest(session, extra = {}) {
  const src = sourceChunksDir(session);
  const utterances = [];
  for (const u of session.timeline || []) {
    if (!u.file) continue;
    // Resolve by basename within the effective source dir (live or archived).
    const file = path.join(src, path.basename(u.file));
    let sha256 = null;
    let bytes = 0;
    try {
      const buf = fs.readFileSync(file);
      bytes = buf.length;
      sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (e) {
      warn('finalize: cannot read', file, '-', e.message);
      continue;
    }
    utterances.push({
      userId: String(u.userId),
      username: u.username,
      file: path.basename(u.file),
      sha256,
      bytes,
      startMs: u.startMs,
      durationMs: u.durationMs,
    });
  }
  return {
    sessionId: String(session.startedAt),
    // Human-readable id (e.g. 2026-05-29T12-45-09-543Z) — used for server-side
    // archive/transcript folder names so they match the bot's session ids.
    sessionName: session.id,
    sessionStartMs: session.startedAt,
    channelName: extra.channelName ?? null,
    guildName: extra.guildName ?? null,
    wakeWord: extra.wakeWord ?? null,
    botVersion: extra.botVersion ?? null,
    utterances,
  };
}

// Live directory for this session's utterance WAVs (recording target + the
// thing applyRetention moves away).
export function chunksDir(session) {
  return path.join(session.dir, 'chunks');
}

// Where the WAVs actually are for finalize: the live chunks dir while recording,
// or the retained `_archived/<id>/chunks` after a previous finalize moved them
// (enables re-finalize via `/finalize run session:<id>`).
export function sourceChunksDir(session) {
  const live = chunksDir(session);
  try {
    if (fs.existsSync(live) && fs.readdirSync(live).some((f) => f.endsWith('.wav'))) return live;
  } catch {}
  const archived = path.join(path.dirname(session.dir), '_archived', session.id, 'chunks');
  if (fs.existsSync(archived)) return archived;
  return live;
}

// Write the manifest next to the WAVs so it travels with them on upload; the
// server reads <uploadDir>/manifest.json rather than receiving it over the
// size-limited control socket.
export function writeManifest(session, manifest) {
  const dir = sourceChunksDir(session);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'manifest.json');
  fs.writeFileSync(fp, JSON.stringify(manifest, null, 2));
  return fp;
}

// Upload the session's WAVs to the server via a user-configured command
// template (FINALIZE_UPLOAD_CMD). Placeholders: {src} = local chunks dir,
// {sessionId}. The command must land the WAVs at
// <server FINALIZE_UPLOAD_DIR>/<sessionId>/<basename>.wav.
// When unset, upload is skipped (bot+server share a filesystem, or the WAVs
// were placed there by other means) and finalize proceeds.
export async function uploadSession(session) {
  const tmpl = process.env.FINALIZE_UPLOAD_CMD;
  const src = sourceChunksDir(session);
  const sessionId = String(session.startedAt);
  if (!tmpl || !tmpl.trim()) {
    warn('finalize: FINALIZE_UPLOAD_CMD not set — skipping upload (assuming server already has the WAVs)');
    return { uploaded: false, skipped: true };
  }
  const cmd = tmpl.replaceAll('{src}', src).replaceAll('{sessionId}', sessionId);
  debug('finalize: upload cmd:', cmd);
  await runShell(cmd);
  log('finalize: uploaded WAVs for session', sessionId);
  return { uploaded: true, skipped: false };
}

function runShell(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout?.on('data', (d) => debug('upload:', d.toString().trim()));
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`upload command exited ${code}: ${stderr.slice(0, 300)}`)));
  });
}

// After the server confirms a durable archive (matching checksums), apply the
// retention policy to the local WAVs: 'move' to <DATA_DIR>/_archived/<id>/ or
// 'delete'. Default 'move' (never destroy audio implicitly).
export function applyRetention(session, { policy = process.env.ARCHIVE_RETENTION ?? 'move' } = {}) {
  const src = chunksDir(session);
  if (!fs.existsSync(src)) return { policy, done: true, noop: true }; // already archived/removed
  if (policy === 'delete') {
    fs.rmSync(src, { recursive: true, force: true });
    log('finalize: deleted local WAVs for', session.id);
  } else {
    const dest = path.join(path.dirname(session.dir), '_archived', session.id, 'chunks');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); // re-finalize: replace
    fs.renameSync(src, dest);
    log('finalize: moved local WAVs to', dest);
  }
  return { policy, done: true };
}
