import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { log, warn, debug } from './logger.js';
import { httpBaseUrl } from './transport/index.js';
import { writeFileAtomic } from './fsSafe.js';

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
  writeFileAtomic(fp, JSON.stringify(manifest, null, 2));
  return fp;
}

// Upload the session's WAVs (+ manifest.json) to the server so finalize can
// re-STT and archive them. Three modes, in priority order:
//
//   1. FINALIZE_UPLOAD_CMD set → run that command template (legacy LAN/Windows
//      profile, e.g. scp/SSH). Placeholders: {src} = local chunks dir,
//      {sessionId}. Must land the files at <server FINALIZE_UPLOAD_DIR>/
//      <sessionId>/<basename>. UNCHANGED from before.
//   2. Otherwise, if a server base URL is configured (SERVER_BASE_URL, via
//      httpBaseUrl()) → HTTP upload straight over the existing connection: one
//      PUT /finalize/upload/<sessionId>/<basename> per file. This is the new
//      default and the only transport that works for the WireGuard-only cloud
//      instance (no scp target).
//   3. No command and no base URL → skip (bot+server share a filesystem, or a
//      local no-server setup); finalize proceeds assuming the WAVs are already
//      there. Preserves the original skip behaviour.
export async function uploadSession(session) {
  const tmpl = process.env.FINALIZE_UPLOAD_CMD;
  const src = sourceChunksDir(session);
  const sessionId = String(session.startedAt);

  // Mode 1: legacy command template — path preserved verbatim.
  if (tmpl && tmpl.trim()) {
    const cmd = tmpl.replaceAll('{src}', src).replaceAll('{sessionId}', sessionId);
    debug('finalize: upload cmd:', cmd);
    await runShell(cmd);
    log('finalize: uploaded WAVs for session', sessionId);
    return { uploaded: true, skipped: false, method: 'cmd' };
  }

  // Mode 3: nothing configured → skip (unchanged from the original behaviour).
  const base = httpBaseUrl();
  if (!base) {
    warn('finalize: no FINALIZE_UPLOAD_CMD and no SERVER_BASE_URL — skipping upload (assuming server already has the WAVs)');
    return { uploaded: false, skipped: true };
  }

  // Mode 2 (new default): HTTP upload. Same source dir the scp path uses; upload
  // the WAVs plus the manifest the server reads (<uploadDir>/manifest.json).
  const bearer = process.env.CONTROL_BEARER || '';
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.wav') || f === 'manifest.json');
  if (files.length === 0) {
    warn('finalize: no WAVs/manifest to upload in', src, '— skipping');
    return { uploaded: false, skipped: true };
  }

  // Sequential — no parallel storm over the tunnel. Content-Length is sent so
  // the server can bound the write; duplex:'half' is mandatory for a stream
  // body under Node 22 undici (it throws otherwise).
  let bytes = 0;
  for (const name of files) {
    const fp = path.join(src, name);
    const { size } = fs.statSync(fp);
    const url = `${base}/finalize/upload/${sessionId}/${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
      },
      body: fs.createReadStream(fp),
      duplex: 'half',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`finalize upload of ${name} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    bytes += size;
    debug('finalize: uploaded', name, `(${size}B)`);
  }
  log('finalize: uploaded', files.length, 'file(s),', bytes, 'bytes for session', sessionId, 'via HTTP');
  return { uploaded: true, skipped: false, method: 'http', files: files.length, bytes };
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
// retention policy to the local WAVs:
//   move              → <DATA_DIR>/_archived/<id>/ (default; never destroy audio implicitly)
//   delete            → remove them
//   delete-after-pull → remove them only if the bot's own archive pull
//                       (BOT_ARCHIVE_DIR, e.g. on the NAS) verified every file;
//                       otherwise move, like the default
// Returns { policy (as applied), done, noop? }.
export function applyRetention(session, { policy = process.env.ARCHIVE_RETENTION ?? 'move', pulled = false } = {}) {
  const src = chunksDir(session);
  if (!fs.existsSync(src)) return { policy, done: true, noop: true }; // already archived/removed
  const effective = policy === 'delete-after-pull' ? (pulled ? 'delete' : 'move') : policy;
  if (effective === 'delete') {
    fs.rmSync(src, { recursive: true, force: true });
    log('finalize: deleted local WAVs for', session.id, policy === 'delete-after-pull' ? '(archive pull verified)' : '');
  } else {
    const dest = path.join(path.dirname(session.dir), '_archived', session.id, 'chunks');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); // re-finalize: replace
    fs.renameSync(src, dest);
    log('finalize: moved local WAVs to', dest);
  }
  return { policy: effective, done: true };
}

// ARCHIVED_RETENTION_DAYS: delete <DATA_DIR>/_archived/<id> folders older than
// N days. Their WAVs are only the bot's leftover copy — the server archive
// (and, with BOT_ARCHIVE_DIR on the NAS, the pulled copy) holds the originals,
// and a re-finalize from Discord rebuilds from the server archive. Unset, 0 or
// "off" → never prune (the default).
export function archivedRetentionDays(raw = process.env.ARCHIVED_RETENTION_DAYS) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function pruneArchived(dataDir, days, now = Date.now()) {
  if (!days) return [];
  const root = path.join(dataDir, '_archived');
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const pruned = [];
  for (const name of names) {
    const p = path.join(root, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true });
        pruned.push(name);
      }
    } catch (e) { warn('finalize: _archived cleanup failed for', name, '-', e.message); }
  }
  if (pruned.length) log(`finalize: _archived cleanup removed ${pruned.length} folder(s) older than ${days} days:`, pruned.join(', '));
  return pruned;
}

let _archivedTimer = null;
// Call once at bot startup: prunes now, then daily.
export function startArchivedCleanup(dataDir) {
  if (_archivedTimer) return;
  const days = archivedRetentionDays();
  if (!days) return;
  pruneArchived(dataDir, days);
  _archivedTimer = setInterval(() => pruneArchived(dataDir, days), 24 * 60 * 60 * 1000);
  _archivedTimer.unref?.();
}
