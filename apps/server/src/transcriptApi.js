// Read-only live-transcript web UI: HTTP routes + SSE stream.
//
// All endpoints live under /transcript on the SAME Express app / port (7440)
// as /health. SSE is a plain GET (text/event-stream), so it does NOT touch the
// WebSocket upgrade dispatcher in index.js.
//
//   GET /transcript/            → static UI (public/index.html + assets)
//   GET /transcript/sessions    → JSON list of in-RAM sessions (picker/auto-detect)
//   GET /transcript/snapshot/:id→ JSON full snapshot (polling fallback)
//   GET /transcript/live[?sessionId=] → SSE: snapshot event, then live entries
//
// Auth (Basic) is layered on in a separate step; see registerTranscriptRoutes.

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { debug } from './logger.js';
import { subscribeEntries, subscribePresence, subscribeAnnotation } from './liveBus.js';
import { buildSnapshot, buildVoice, newestActiveSessionId, listSessions, listSessionsOnDisk } from './transcriptView.js';
import { makeTranscriptAuth } from './transcriptAuth.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const SSE_HEARTBEAT_MS = 15000;

// Resolve the session to show: an explicit numeric query param wins; otherwise
// fall back to the newest active session in RAM.
function resolveSessionId(raw) {
  if (raw != null && /^\d+$/.test(String(raw))) return String(raw);
  return newestActiveSessionId();
}

// Shape a bus/entry into the wire form the client expects. `meta` is only
// attached when present (debug-only fields like noSpeechProb).
function toClientEntry(entry, meta) {
  const out = { label: entry.label, text: entry.text, startMs: entry.startMs, kind: entry.kind };
  // Structured render data: segments = natural-silence groups (non-debug block),
  // chunks = per-whisper-chunk {text,split} (debug view). partial = live, not final.
  if (Array.isArray(entry.segments)) out.segments = entry.segments;
  if (Array.isArray(entry.chunks)) out.chunks = entry.chunks;
  if (entry.partial) out.partial = true;
  if (entry.meta) out.meta = entry.meta;
  if (meta) out.meta = { ...(out.meta || {}), ...meta };
  return out;
}

// Active (in-RAM) sessions by default; `?all=1` additionally returns the past
// sessions found on disk (those not already active), so the UI can offer them.
function handleSessions(req, res) {
  const active = listSessions();
  const wantAll = req.query.all === '1' || req.query.all === 'true';
  if (!wantAll) { res.json({ sessions: active }); return; }
  const activeIds = new Set(active.map((s) => s.sessionId));
  const past = listSessionsOnDisk().filter((s) => !activeIds.has(s.sessionId));
  res.json({ sessions: active, past });
}

function handleSnapshot(req, res) {
  const sid = resolveSessionId(req.params.id);
  if (!sid) { res.status(404).json({ error: 'no session' }); return; }
  try {
    res.json(buildSnapshot(sid));
  } catch (e) {
    debug('transcript: snapshot error', e.message);
    res.status(500).json({ error: 'snapshot failed' });
  }
}

function handleLive(req, res) {
  const sid = resolveSessionId(req.query.sessionId);
  if (!sid) { res.status(404).json({ error: 'no active session' }); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx) so events flush live
  });
  res.write('retry: 3000\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Subscribe BEFORE building the snapshot so entries appended in the gap
  // aren't lost; buffer them, then replay only those newer than the snapshot.
  const pending = [];
  let ready = false;
  const unsubEntries = subscribeEntries((msg) => {
    if (msg.sessionId !== sid) return;
    if (!ready) { pending.push(msg); return; }
    send('entry', toClientEntry(msg.entry, msg.meta));
  });
  // Voice presence changes (bot join/leave, members in/out) for this session.
  const unsubPresence = subscribePresence((msg) => {
    if (msg.sessionId !== sid) return;
    try { send('presence', buildVoice(sid)); } catch {}
  });
  // Retro-classification of an already-sent line (wake-word/stop detected after
  // the utterance was appended). Client patches the line by startMs.
  const unsubAnnotation = subscribeAnnotation((msg) => {
    if (msg.sessionId !== sid) return;
    send('annotation', msg.annotation);
  });

  try {
    const snap = buildSnapshot(sid);
    send('snapshot', snap);
    const lastMs = snap.entries.length ? snap.entries[snap.entries.length - 1].startMs : -Infinity;
    ready = true;
    for (const msg of pending) {
      if (msg.entry.startMs > lastMs) send('entry', toClientEntry(msg.entry, msg.meta));
    }
  } catch (e) {
    debug('transcript: live snapshot error', e.message);
    send('error', { message: 'snapshot failed' });
    ready = true;
  } finally {
    pending.length = 0;
  }

  // Comment heartbeat keeps idle proxies/connections from timing out.
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, SSE_HEARTBEAT_MS);
  hb.unref?.();

  req.on('close', () => { clearInterval(hb); unsubEntries(); unsubPresence(); unsubAnnotation(); });
}

// Register all /transcript routes on the given Express app. Optional Basic auth
// (on by default, see transcriptAuth.js) guards every /transcript request,
// static assets included.
export function registerTranscriptRoutes(app) {
  const auth = makeTranscriptAuth();
  if (auth) app.use('/transcript', auth);
  // API routes first, then the static fallback (so /transcript/live etc. win).
  app.get('/transcript/sessions', handleSessions);
  app.get('/transcript/snapshot/:id', handleSnapshot);
  app.get('/transcript/live', handleLive);
  app.use('/transcript', express.static(PUBLIC_DIR));
}
