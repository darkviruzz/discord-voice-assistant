import fs from 'fs';
import { mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import path from 'path';
import { join } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { Readable, PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import { httpBaseUrl } from './transport/index.js';
import { log, warn, debug } from './logger.js';

// Where the bot keeps its own (persistent-host) copy of the finished session
// archives (transcript.md, manifest.json, speaker-map.json, session.jsonl,
// audio/*). The finalize archive is built on the (ephemeral, cloud) server and
// dies with the instance on auto-stop; right after a successful finalize the bot
// pulls it back here over the same WireGuard link. Mirrors BOT_TRANSCRIPT_DIR in
// transcriptWriter.js (default ~/archive, longer default retention).
const DIR = process.env.BOT_ARCHIVE_DIR || join(homedir(), 'archive');
const RETENTION_DAYS = Number(process.env.BOT_ARCHIVE_RETENTION_DAYS) || 60;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Same shape the server's archive routes accept: a single root file ('name') or
// one level under audio/ ('audio/name'). Guards a hostile/buggy manifest from
// steering a write outside the per-archive destination directory.
function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return false;
  if (rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.startsWith('/')) return false;
  const parts = rel.split('/');
  if (parts.length > 2) return false;
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') return false;
    if (path.basename(p) !== p) return false;
  }
  if (parts.length === 2 && parts[0] !== 'audio') return false;
  return true;
}

// Stream a fetch body to disk while computing its sha256 in one pass (archive
// WAVs/OGGs are many MB — never buffer the whole file). Returns the hex digest.
// A stream error rejects; the caller removes the partial file.
async function streamToFileWithSha(webBody, dest) {
  const h = crypto.createHash('sha256');
  if (!webBody) {
    // 0-byte file: fetch may expose no body stream.
    fs.writeFileSync(dest, Buffer.alloc(0));
    return h.digest('hex');
  }
  const tap = new PassThrough();
  tap.on('data', (chunk) => h.update(chunk));
  await pipeline(Readable.fromWeb(webBody), tap, fs.createWriteStream(dest));
  return h.digest('hex');
}

// Pull a finished archive back onto the persistent bot host. Fetches the
// server-built manifest, then streams each file, verifying its sha256 against
// the manifest. Files land in BOT_ARCHIVE_DIR/<archiveName>/<relPath>.
//
// Returns:
//   { skipped: true }                          — no server base URL / no name (no-op)
//   { ok, files, failed: [relPath], bytes }    — ok=false if any single file failed
// Throws ONLY on a total failure (manifest unreachable); individual file
// failures are collected in `failed` and a corrupt partial file is deleted.
export async function pullArchive({ archiveName } = {}) {
  const base = httpBaseUrl();
  if (!base) {
    debug('archivePuller: no SERVER_BASE_URL — skipping archive pull');
    return { skipped: true };
  }
  if (typeof archiveName !== 'string' || archiveName.length === 0) {
    debug('archivePuller: no archiveName — skipping');
    return { skipped: true };
  }
  // archiveName (from the server's finalize result) becomes the destination
  // dir under DIR — same rule as the server's isSafeArchiveName: one plain
  // directory name, never '.'/'..' or anything with a separator.
  if (archiveName === '.' || archiveName === '..' || archiveName.replace(/[^A-Za-z0-9._-]/g, '') !== archiveName) {
    throw new Error(`unsafe archiveName ${JSON.stringify(archiveName).slice(0, 80)}`);
  }

  const bearer = process.env.CONTROL_BEARER || '';
  const headers = { Authorization: `Bearer ${bearer}` };
  const encName = encodeURIComponent(archiveName);

  // Manifest first — an unreachable manifest is a total failure (throw).
  const manifestUrl = `${base}/finalize/archive/${encName}/manifest`;
  const mRes = await fetch(manifestUrl, { headers });
  if (!mRes.ok) {
    const body = await mRes.text().catch(() => '');
    throw new Error(`archive manifest fetch failed: HTTP ${mRes.status} ${body.slice(0, 200)}`);
  }
  const manifest = await mRes.json();
  const files = Array.isArray(manifest.files) ? manifest.files : [];

  const destRoot = join(DIR, archiveName);
  mkdirSync(destRoot, { recursive: true });

  const failed = [];
  let okCount = 0;
  let bytes = 0;

  // Sequential — no parallel storm over the tunnel.
  for (const f of files) {
    const relPath = f && f.relPath;
    if (!isSafeRelPath(relPath)) {
      warn('archivePuller: skipping unsafe relPath', relPath);
      if (relPath) failed.push(relPath);
      continue;
    }
    const dest = join(destRoot, relPath);
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      const url = `${base}/finalize/archive/${encName}/file?path=${encodeURIComponent(relPath)}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sha = await streamToFileWithSha(res.body, dest);
      if (f.sha256 && sha !== f.sha256) {
        try { rmSync(dest, { force: true }); } catch {}
        throw new Error(`sha256 mismatch (want ${String(f.sha256).slice(0, 12)}…, got ${sha.slice(0, 12)}…)`);
      }
      okCount++;
      bytes += Number(f.bytes) || 0;
      debug('archivePuller: pulled', relPath, sha.slice(0, 12));
    } catch (e) {
      warn('archivePuller: failed', relPath, '-', e.message);
      failed.push(relPath);
    }
  }

  const ok = failed.length === 0;
  log(`archivePuller: ${archiveName} → ${destRoot} (${okCount}/${files.length} files, ${bytes} bytes${ok ? '' : `, ${failed.length} failed`})`);
  return { ok, files: okCount, failed, bytes };
}

function pruneOldArchives() {
  try {
    mkdirSync(DIR, { recursive: true });
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(DIR)) {
      const p = join(DIR, name);
      try {
        const st = statSync(p);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          rmSync(p, { recursive: true, force: true });
          debug('archivePuller: pruned', name);
        }
      } catch { /* dir vanished or unreadable — skip */ }
    }
  } catch (e) {
    warn('archivePuller: cleanup error:', e.message);
  }
}

let cleanupTimer = null;
// Call once at bot startup. Prunes immediately, then daily, so BOT_ARCHIVE_DIR
// doesn't grow unbounded over many sessions. Mirrors startTranscriptCleanup().
export function startArchiveCleanup() {
  if (cleanupTimer) return;
  pruneOldArchives();
  cleanupTimer = setInterval(pruneOldArchives, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}
