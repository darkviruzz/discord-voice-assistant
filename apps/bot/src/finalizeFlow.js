import { SessionStatus } from './session.js';
import { describeError } from './fsSafe.js';
import { formatBytes } from './diskSpace.js';

// The finalize steps between "control link is up" and "result is known",
// separated from index.js so the status rules can be tested on their own.
//
// Status rules (both broke on 2026-11-04 when the bot host's disk was full):
//   - Until the server reports a finished archive, any failure puts the
//     session back to its previous status — in memory always, on disk when
//     the disk lets us. Before, a failing FINALIZING save happened outside the
//     try block: the in-memory session stayed FINALIZING and every later
//     /finalize run answered "wird bereits finalisiert".
//   - Once the server has the finished archive, the session IS finalized.
//     Archive pull, WAV retention and saving the status are best effort and
//     only annotate the result. Before, a failing retention step reverted a
//     finished session to OPEN, and auto-finalize started it over.

// Session ids with a finalize running. Throws if one is already running for
// `id`; otherwise runs fn and always releases the id, whatever fn does.
export async function withFinalizeLock(locks, id, fn) {
  if (locks.has(id)) throw new Error('Diese Session wird bereits finalisiert.');
  locks.add(id);
  try {
    return await fn();
  } finally {
    locks.delete(id);
  }
}

// deps: {
//   saveSession(session), buildManifest(session, extra), writeManifest(session, manifest),
//   prepare(sessionId), upload(session), finalizeSession({ sessionId, sessionName }),
//   pullArchive({ archiveName }), applyRetention(session, { pulled }),
//   warn(...args), now()
// }
export async function runFinalizeFlow(session, { fromArchive = false, manifestExtra = {}, onProgress = () => {} } = {}, deps) {
  const warn = deps.warn ?? (() => {});
  const now = deps.now ?? Date.now;
  const prevStatus = session.status;
  session.status = SessionStatus.FINALIZING;
  let result;
  try {
    deps.saveSession(session);
    if (fromArchive) {
      // Re-finalize: no upload — the server rebuilds from the archived originals.
      onProgress('⏳ Server finalisiert aus dem Archiv neu …');
      result = await deps.finalizeSession({ sessionId: String(session.startedAt), sessionName: session.id });
    } else {
      const manifest = deps.buildManifest(session, manifestExtra);
      if (manifest.utterances.length === 0) throw new Error('Session enthält keine aufgenommenen Äußerungen.');
      deps.writeManifest(session, manifest);

      onProgress(`⏳ Lade ${manifest.utterances.length} Audiodateien zum Server …`);
      // Ensure the server-side upload dir exists (scp won't create it remotely).
      try { await deps.prepare(manifest.sessionId); }
      catch (e) { warn('finalize: prepare failed (continuing):', e.message); }
      await deps.upload(session);

      onProgress('⏳ Server transkribiert und baut das Transkript …');
      result = await deps.finalizeSession({ sessionId: manifest.sessionId, sessionName: session.id });
    }
    if (!result?.ok) throw new Error(result?.error || 'Finalize fehlgeschlagen');
  } catch (e) {
    session.status = prevStatus;
    try { deps.saveSession(session); }
    catch (e2) { warn('finalize: could not persist the status revert:', describeError(e2)); }
    throw e;
  }

  // ---- The server holds the finished archive. Nothing below may undo that. ----
  const fullyVerified = (result.missing?.length ?? 0) === 0 && (result.mismatched?.length ?? 0) === 0;
  session.status = SessionStatus.FINALIZED;
  session.finalizedAt = now();
  session.finalize = { transcriptPath: result.transcriptPath, archiveDir: result.archiveDir, userCount: result.userCount };
  let saveNote = '';
  try { deps.saveSession(session); }
  catch (e) {
    warn('finalize: finalized, but session.json could not be saved:', describeError(e));
    saveNote = ' ⚠️ Status „finalisiert“ konnte auf dem Bot nicht gespeichert werden (Speicher voll?) — Ergebnis liegt trotzdem vollständig auf dem Server.';
  }

  // Pull the finished archive back onto the persistent bot host (on a cloud
  // instance the archive dies with the box at auto-stop).
  let archiveNote = '';
  let pull = null;
  if (result.archiveName) {
    try {
      pull = await deps.pullArchive({ archiveName: result.archiveName });
      if (pull?.ok) {
        archiveNote = ` 📦 Archiv lokal gesichert (${pull.files} Dateien).`;
      } else if (pull?.noSpace) {
        archiveNote = ` ⚠️ Archiv-Pull übersprungen: nur ${formatBytes(pull.noSpace.free)} frei, Archiv braucht ${formatBytes(pull.noSpace.need)} — Original bleibt im Server-Archiv.`;
      } else if (pull && !pull.skipped) {
        archiveNote = pull.diskFull
          ? ' ⚠️ Archiv-Pull abgebrochen: Bot-Speicher voll — Original bleibt im Server-Archiv.'
          : ` ⚠️ Archiv-Pull unvollständig (${pull.failed?.length ?? 0} Datei(en) fehlgeschlagen) — stop.sh --backup bleibt als Netz.`;
      }
    } catch (e) {
      warn('finalize: archive pull failed:', e.message);
      archiveNote = ' ⚠️ Archiv-Pull fehlgeschlagen — stop.sh --backup bleibt als Netz.';
    }
  }

  let retentionNote = '';
  if (fromArchive) {
    retentionNote = '';
  } else if (fullyVerified) {
    try {
      const r = deps.applyRetention(session, { pulled: !!pull?.ok });
      retentionNote = r.noop ? '' : (r.policy === 'delete' ? ' Lokale WAVs gelöscht (Original liegt im Server-Archiv).' : ' Lokale WAVs ins _archived/ verschoben.');
    } catch (e) {
      warn('finalize: retention failed:', describeError(e));
      retentionNote = ` ⚠️ Lokale WAVs konnten nicht aufgeräumt werden (${describeError(e)}) — sie bleiben liegen.`;
    }
  } else {
    retentionNote = ` ⚠️ ${result.missing?.length ?? 0} fehlende / ${result.mismatched?.length ?? 0} fehlerhafte Uploads – lokale WAVs bleiben für erneuten Versuch erhalten.`;
  }

  return { result, fullyVerified, retentionNote: retentionNote + archiveNote + saveNote };
}
