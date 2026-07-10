/**
 * Finalize audio upload over HTTP: PUT /finalize/upload/:sessionId/:filename
 *
 * Replaces the old scp-based FINALIZE_UPLOAD_CMD transport for the cloud
 * instance (reachable only via WireGuard, no scp target). The bot streams each
 * session WAV plus manifest.json straight over the existing server connection;
 * they land in the same per-session upload dir the control socket's
 * finalize_prepare already uses, so finalizeSession's checksum verification is
 * unchanged — only the transport differs.
 *
 * Auth reuses checkBearer() (CONTROL_BEARER), exactly like the ws routes.
 * The body is STREAMED to disk (WAVs are several MB); no express.json/multer.
 * The global express.json({limit:'32kb'}) only fires on Content-Type
 * application/json and does not touch these application/octet-stream requests.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream';
import { checkBearer } from './auth.js';
import { ensureUploadDir } from './control.js';
import { log, warn, debug } from './logger.js';

// Hard cap on a single upload. A finalized session WAV is a few MB; 200MB is a
// generous ceiling that still refuses a runaway/hostile Content-Length.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_FILENAME_LEN = 255;

// filename must be a pure basename: no path separators, no traversal, non-empty,
// bounded length. Express has already URL-decoded req.params, so a client that
// sent `%2F` arrives here as a literal '/' and is caught.
function isSafeFilename(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_FILENAME_LEN) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  // Belt-and-suspenders: whatever we got must equal its own basename.
  return path.basename(name) === name;
}

// Root of the finalized session archives (matches control.js's resolution and
// finalizeSession's ARCHIVE_DIR default).
function archiveRootDir() {
  return (process.env.ARCHIVE_DIR ?? './archive').replace(/\/+$/, '');
}

// archiveName must survive the exact same sanitizing that archiveDirName()
// applies server-side (finalize/index.js): stripping [^A-Za-z0-9._-] must be a
// no-op, so the parameter can only name a single, separator-free directory. '.'
// and '..' are refused outright. This charset cannot contain '/', '\\' or '\0',
// so no traversal is representable.
function isSafeArchiveName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  return name.replace(/[^A-Za-z0-9._-]/g, '') === name;
}

// relPath (the file route's ?path=) may only be a single root file ('name') or
// one level under audio/ ('audio/name'): no leading '/', no '..' segment, no
// backslash, at most two '/'-separated segments with 'audio' as the only legal
// parent. A path.resolve containment check backs this up at the call site.
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

// Stream a file through sha256 without ever holding it in RAM (archive WAVs/OGGs
// run to many MB). Resolves the lowercase hex digest.
function sha256Stream(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// List the archive's durable files: every regular file in the archive root
// (non-recursive) plus one level of audio/*. relPath always uses '/' (so the
// bot can address ?path= identically on any OS). sha256 is computed streaming.
async function listArchiveFiles(archiveDir) {
  const out = [];
  const addFrom = async (dir, prefix) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const fp = path.join(dir, name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ relPath: prefix + name, sha256: await sha256Stream(fp), bytes: st.size });
    }
  };
  await addFrom(archiveDir, '');
  await addFrom(path.join(archiveDir, 'audio'), 'audio/');
  return out;
}

export function registerFinalizeHttpRoutes(app, { bearer = process.env.CONTROL_BEARER } = {}) {
  app.put('/finalize/upload/:sessionId/:filename', (req, res) => {
    if (!checkBearer(req, bearer)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { sessionId, filename } = req.params;
    if (!/^\d+$/.test(sessionId)) {
      return res.status(400).json({ ok: false, error: 'bad sessionId' });
    }
    if (!isSafeFilename(filename)) {
      return res.status(400).json({ ok: false, error: 'bad filename' });
    }

    // Content-Length is mandatory (so we can bound the write up front) and capped.
    const lenRaw = req.headers['content-length'];
    if (lenRaw == null) {
      return res.status(411).json({ ok: false, error: 'content-length required' });
    }
    const len = Number(lenRaw);
    if (!Number.isFinite(len) || len < 0) {
      return res.status(400).json({ ok: false, error: 'bad content-length' });
    }
    if (len > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ ok: false, error: `too large (max ${MAX_UPLOAD_BYTES} bytes)` });
    }

    let dir;
    try {
      dir = ensureUploadDir(sessionId);
    } catch (e) {
      warn('finalize upload: cannot create dir for', sessionId, '-', e.message);
      return res.status(500).json({ ok: false, error: 'cannot create upload dir' });
    }
    const dest = path.join(dir, filename);
    const cleanup = () => { try { fs.rmSync(dest, { force: true }); } catch {} };

    const out = fs.createWriteStream(dest);
    // pipeline() destroys both streams and calls back on the first error, so a
    // client disconnect or disk error never leaves a dangling handle. We still
    // best-effort delete the partial file — no corrupt half-files linger (the
    // finalize checksum verification would reject them anyway, but tidy is tidy).
    pipeline(req, out, (err) => {
      if (err) {
        warn('finalize upload: stream error for', sessionId, filename, '-', err.message);
        cleanup();
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'upload failed' });
        return;
      }
      debug('finalize upload:', sessionId, filename, out.bytesWritten, 'bytes');
      res.status(200).json({ ok: true, bytes: out.bytesWritten });
    });
  });

  // Archive manifest: the durable file list (root files + audio/*) with streaming
  // sha256, so the bot can pull the finished archive off the ephemeral instance
  // and verify each file. Same bearer as the upload route.
  app.get('/finalize/archive/:archiveName/manifest', async (req, res) => {
    if (!checkBearer(req, bearer)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const { archiveName } = req.params;
    if (!isSafeArchiveName(archiveName)) {
      return res.status(400).json({ ok: false, error: 'bad archiveName' });
    }
    const archiveDir = path.resolve(archiveRootDir(), archiveName);
    let st;
    try { st = fs.statSync(archiveDir); } catch { st = null; }
    if (!st || !st.isDirectory()) {
      return res.status(404).json({ ok: false, error: 'archive not found' });
    }
    try {
      const files = await listArchiveFiles(archiveDir);
      res.status(200).json({ archiveName, files });
    } catch (e) {
      warn('finalize archive manifest:', archiveName, '-', e.message);
      res.status(500).json({ ok: false, error: 'manifest failed' });
    }
  });

  // Archive file stream: one durable file at a time, addressed by ?path=<relPath>
  // (either 'name' or 'audio/name'). Streamed with a Content-Length; never buffers.
  app.get('/finalize/archive/:archiveName/file', (req, res) => {
    if (!checkBearer(req, bearer)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const { archiveName } = req.params;
    if (!isSafeArchiveName(archiveName)) {
      return res.status(400).json({ ok: false, error: 'bad archiveName' });
    }
    const rel = req.query.path;
    if (!isSafeRelPath(rel)) {
      return res.status(400).json({ ok: false, error: 'bad path' });
    }
    const archiveDir = path.resolve(archiveRootDir(), archiveName);
    const target = path.resolve(archiveDir, rel);
    // Defense in depth against a validator gap: the resolved path must stay
    // strictly inside the archive directory.
    if (target !== archiveDir && !target.startsWith(archiveDir + path.sep)) {
      return res.status(400).json({ ok: false, error: 'path escapes archive' });
    }
    let st;
    try { st = fs.statSync(target); } catch { st = null; }
    if (!st || !st.isFile()) {
      return res.status(404).json({ ok: false, error: 'file not found' });
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));
    const stream = fs.createReadStream(target);
    stream.on('error', (e) => {
      warn('finalize archive file:', archiveName, String(rel), '-', e.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'read failed' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  log('finalize http routes ready');
}
