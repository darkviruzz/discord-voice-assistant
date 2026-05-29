import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { buildModelFromEvents, mergeTranscript, speakerLabel, isBracketOnly, markDetections, computeParticipants, weaveAssistantTurns } from './merge.js';
import { buildAudioArchive } from './archive.js';
import { warn, log } from '../logger.js';

// Default re-STT is lazy-loaded so importing the orchestrator (e.g. in tests
// with an injected transcribeFn) does not pull in the whole server pipeline
// and its native opus addon.
async function defaultTranscribe(absPath) {
  const { transcribeWavFile } = await import('./sttFile.js');
  return transcribeWavFile(absPath);
}

export function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

// Verify uploaded WAVs against the bot-supplied checksums. Returns sets so the
// orchestrator can finalize the verified utterances and report the rest as gaps
// to reconcile (re-upload).
export function verifyUploads(manifest, uploadDir) {
  const verified = new Set();
  const missing = [];
  const mismatched = [];
  for (const u of manifest.utterances || []) {
    const file = path.join(uploadDir, u.file);
    if (!fs.existsSync(file)) { missing.push(u.file); continue; }
    if (u.sha256) {
      const actual = sha256File(file);
      if (actual !== u.sha256) { mismatched.push(u.file); continue; }
    }
    verified.add(u.file);
  }
  return { verified, missing, mismatched };
}

// Assemble the render model: authoritative user spans from re-STT of the
// uploaded WAVs, plus assistant/typed spans carried over from the JSONL events.
// `transcribeFn(absPath) → {text, words}` is injectable for tests.
export async function buildFinalizeModel({
  sessionId, manifest, events = [], uploadDir,
  transcribeFn = null, speakerMap = {}, verified = null, assistantName = null,
}) {
  const transcribe = transcribeFn || defaultTranscribe;
  const asstName = assistantName || manifest.wakeWord || manifest.assistantName || undefined;
  const sessionStartMs = Number(manifest.sessionStartMs ?? sessionId);

  const userSpans = [];
  for (const u of manifest.utterances || []) {
    if (verified && !verified.has(u.file)) continue; // skip unverified/missing
    const abs = path.join(uploadDir, u.file);
    let text = '';
    let words = null;
    try {
      ({ text, words } = await transcribe(abs));
    } catch (e) {
      warn('finalize: STT failed for', u.file, '-', e.message);
      continue;
    }
    if (!text || isBracketOnly(text)) continue;
    const startMs = sessionStartMs + (Number(u.startMs) || 0);
    userSpans.push({
      type: 'user',
      userId: u.userId != null ? String(u.userId) : null,
      label: speakerLabel(u.userId, u.username, speakerMap),
      startMs,
      endMs: startMs + (Number(u.durationMs) || 0),
      text,
      words,
    });
  }

  // Typed-query spans come from the live log; voice user spans are the
  // authoritative re-STT ones above. Assistant turns are woven against the
  // re-STT user spans (so interruption splitting uses the authoritative audio).
  const evModel = buildModelFromEvents(events, { speakerMap, assistantName: asstName });
  const typedSpans = evModel.spans.filter((s) => s.typed);
  const { spans: assistantSpans, consumed } = weaveAssistantTurns(events, {
    clockOffsetMs: evModel.clockOffsetMs, assistantName: asstName, userSpans,
  });

  const spans = [...userSpans.filter((s) => !consumed.has(s)), ...typedSpans, ...assistantSpans];
  markDetections(spans, events, evModel.clockOffsetMs);
  const participants = computeParticipants(spans, events, evModel.clockOffsetMs, speakerMap);

  return {
    spans,
    sessionStartMs,
    clockOffsetMs: evModel.clockOffsetMs,
    participants,
    userCount: userSpans.filter((s) => !consumed.has(s)).length,
  };
}

function archiveDirName(manifest, sessionStartMs, sessionId, timeZone) {
  // Prefer the human-readable bot session id; sanitize for the filesystem.
  const name = typeof manifest.sessionName === 'string' ? manifest.sessionName.replace(/[^A-Za-z0-9._-]/g, '') : '';
  if (name) return name;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(sessionStartMs)); // YYYY-MM-DD
  return `${date}-${sessionId}`;
}

// Full finalize: re-STT → merge → write transcript + archive (audio, jsonl,
// manifest, speaker-map snapshot) → checksum every archived file.
// Returns a result the bot uses to verify durability before cleanup.
export async function finalizeSession({
  sessionId, manifest, events = [], uploadDir,
  transcribeFn = null, speakerMap = {},
  archiveRoot = process.env.ARCHIVE_DIR ?? './archive',
  transcriptRoot = process.env.TRANSCRIPT_DIR ?? './transcripts',
  jsonlPath = null, opts = {},
}) {
  const timeZone = opts.timeZone || process.env.FINALIZE_TZ || 'Europe/Berlin';
  const { verified, missing, mismatched } = verifyUploads(manifest, uploadDir);
  if (missing.length || mismatched.length) {
    warn(`finalize: ${missing.length} missing, ${mismatched.length} mismatched upload(s) — finalizing verified subset`);
  }

  const meta = events.find((e) => e && e.type === 'session_meta') || {};
  const mergedSpeakerMap = { ...(meta.users || {}), ...speakerMap };
  const wakeWord = manifest.wakeWord || meta.wakeword?.word || 'Rabenauge';
  const stopPhrases = Array.isArray(meta.stopPhrases) ? meta.stopPhrases : [];

  const model = await buildFinalizeModel({
    sessionId, manifest, events, uploadDir, transcribeFn,
    speakerMap: mergedSpeakerMap, verified, assistantName: wakeWord,
  });

  const md = mergeTranscript(model, {
    timeZone,
    pauseThresholdS: Number(process.env.PAUSE_THRESHOLD_S ?? 30),
    wakeWord,
    stopPhrases,
    assistantName: wakeWord,
    speakerMap: mergedSpeakerMap,
    channelName: manifest.channelName || meta.channelName || null,
    guildName: manifest.guildName || meta.guildName || null,
  });

  const dirName = archiveDirName(manifest, model.sessionStartMs, sessionId, timeZone);
  const archiveDir = path.resolve(archiveRoot, dirName);
  const transcriptDir = path.resolve(transcriptRoot, dirName);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });

  // transcript.md → both the transcript tree (browseable) and the archive.
  const transcriptPath = path.join(transcriptDir, 'transcript.md');
  fs.writeFileSync(transcriptPath, md);
  fs.writeFileSync(path.join(archiveDir, 'transcript.md'), md);

  // JSONL snapshot.
  if (jsonlPath && fs.existsSync(jsonlPath)) {
    fs.copyFileSync(jsonlPath, path.join(archiveDir, 'session.jsonl'));
  } else if (events.length) {
    fs.writeFileSync(path.join(archiveDir, 'session.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  // Manifest + speaker-map snapshot → re-finalize contract.
  fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(archiveDir, 'speaker-map.json'), JSON.stringify(mergedSpeakerMap, null, 2));

  // Audio archive (OGG/Opus). Best-effort: a failure must not lose the transcript.
  let audio = { files: [], ok: false, error: null };
  try {
    audio = await buildAudioArchive({ manifest, uploadDir, archiveDir, verified, opts });
  } catch (e) {
    warn('finalize: audio archive failed:', e.message);
    audio.error = e.message;
  }

  // Checksum every archived file → durability proof for the bot's cleanup gate.
  const files = [];
  for (const name of fs.readdirSync(archiveDir)) {
    const fp = path.join(archiveDir, name);
    const st = fs.statSync(fp);
    if (!st.isFile()) continue;
    files.push({ name, sha256: sha256File(fp), bytes: st.size });
  }

  // The uploaded WAVs are transient — remove them once fully verified and
  // archived (the OGG archive + bot retention hold the durable copies).
  if (missing.length === 0 && mismatched.length === 0
      && (process.env.FINALIZE_KEEP_UPLOADS ?? 'false') !== 'true') {
    try { fs.rmSync(uploadDir, { recursive: true, force: true }); }
    catch (e) { warn('finalize: upload cleanup failed:', e.message); }
  }

  log(`finalize: session ${sessionId} → ${transcriptPath} (${model.userCount} utterances, ${model.spans.length} spans, audio=${audio.ok ? audio.format : 'skipped'})`);

  return {
    ok: true,
    sessionId: String(sessionId),
    transcriptPath,
    archiveDir,
    files,
    spanCount: model.spans.length,
    userCount: model.userCount,
    verified: [...verified],
    missing,
    mismatched,
    audio,
  };
}
