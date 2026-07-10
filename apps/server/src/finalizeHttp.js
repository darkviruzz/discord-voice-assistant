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

  log('finalize http routes ready');
}
