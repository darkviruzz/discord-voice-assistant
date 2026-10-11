import './bootConfig.js'; // MUSS zuerst stehen: dotenv + Bot-Override-Layer vor allen anderen Imports
import { Client, GatewayIntentBits, Partials, MessageFlags, ActivityType } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { log, warn, error, debug } from './logger.js';
import { SessionManager, SessionStatus } from './session.js';
import { UtteranceRecorder } from './recorder.js';
import { buildManifest, writeManifest, uploadSession, applyRetention } from './finalize.js';
import { getVersion } from './version.js';
import { ensureServerReachable } from './serverAutoStart.js';
import { scheduleServerStop, cancelServerStop } from './serverAutoStop.js';
import { startTranscriptCleanup } from './transcriptWriter.js';
import { pullArchive, startArchiveCleanup } from './archivePuller.js';
import { LeaveFinalizeScheduler } from './leaveFinalize.js';
import { FinalizeStatus, formatProgress, finalizeResultText } from './finalizeStatus.js';
import { chatMessageText, splitDiscordMessage } from './discordText.js';
import { AnswerHolds } from './answerHolds.js';
import * as transport from './transport/index.js';

// Last-resort crash safety: a single corrupt audio packet or stray async error
// must never tear down a live recording. Unhandled promise rejections (the
// class that crashed the bot on a corrupt Opus frame) are logged with their
// full stack and the process keeps running — errors stay visible, just not
// fatal. A genuinely-uncaught synchronous exception may leave undefined state,
// so it is logged and we exit cleanly for a fresh systemd restart.
process.on('unhandledRejection', (reason) => {
  error('unhandledRejection:', reason);
});
process.on('uncaughtException', (e) => {
  error('uncaughtException:', e);
  process.exit(1);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel]
});

const sessions = new SessionManager();
// userId -> UtteranceRecorder (in-flight chunk); lets us dispose() recorders
// when the voice connection leaves READY (their decryption context goes stale).
const activeRecordings = new Map();
let _textChannel = null;
// Discord ID of the voice channel the bot is currently joined to.
// When /ask or an @-mention is sent from this same channel's text chat,
// the request shares conversationHistory with the voice session.
let _activeVoiceChannelId = null;
// Who issued the current /join — used to address server-outage notifications
// (ephemeral while the interaction token is fresh, else a channel mention).
let _sessionOwner = null;        // { interaction, userId }
// De-dupes the server-outage flow so the warning + auto-restart fire once per
// outage, and the recovery message fires once.
const _outage = { active: false, autoRestartTried: false };

// True while the bot is actively in a voice channel with an open session — the
// control link is kept open only in this state (idle bots hold no server link).
function hasActiveSession() { return !!(sessions.active && _activeVoiceChannelId); }

// The server is also still needed while a finalize runs (it holds the control
// link, see performFinalize) — possibly with no active session at all, e.g.
// /finalize after /leave. An idle auto-stop armed meanwhile (/leave, /ask)
// must not shut the server down mid-finalize; the finalize re-arms the stop
// when it is done.
function hasServerWork() { return hasActiveSession() || transport.isLinkHeld(); }

// Release the on-demand server link after a grace period, unless a session is
// keeping it alive. Re-checked when the timer fires, so a /join cancels it (a
// running finalize keeps it via its link hold). While idle we also arm the
// cloud-server idle auto-stop (SERVER_STOP_CMD) — a no-op unless that command
// is configured — so an idle cloud GPU instance is eventually shut down; a
// /join or a starting finalize cancels it.
function maybeScheduleIdleRelease() {
  if (!hasActiveSession()) {
    transport.scheduleIdleRelease({ hasWork: hasActiveSession });
    scheduleServerStop({ hasWork: hasServerWork });
  }
}

// Notify the /join initiator about a server-link event. Prefers an ephemeral
// follow-up (only valid while the interaction token is fresh, ~15 min); falls
// back to a public message in the bound text channel that @-mentions them.
async function notifyOwner(content) {
  const owner = _sessionOwner;
  if (owner?.interaction) {
    const created = owner.interaction.createdTimestamp ?? 0;
    if (Date.now() - created < 14 * 60_000) {
      try { await owner.interaction.followUp({ content, flags: MessageFlags.Ephemeral }); return; }
      catch (e) { debug('notifyOwner ephemeral failed:', e.message); }
    }
  }
  if (_textChannel?.send) {
    const mention = owner?.userId ? `<@${owner.userId}> ` : '';
    try { await _textChannel.send(`${mention}${content}`); }
    catch (e) { debug('notifyOwner channel send failed:', e.message); }
  }
}

// Reacts to control-link up/down transitions. Only meaningful during a session:
// on loss → warn the owner + one automatic SSH restart attempt; on recovery →
// confirm. Local recording keeps running regardless (WAVs are written locally).
async function handleServerLink(info) {
  for (const st of _finalizeStatuses.values()) {
    st.update(info.connected
      ? '🔄 Server wieder verbunden — Finalize wird fortgesetzt …'
      : '⚠️ Verbindung zum Server unterbrochen — der Finalize läuft serverseitig weiter, warte auf Reconnect (max. 30 min) …');
  }
  if (!info.connected) {
    if (!hasActiveSession() || _outage.active) return;   // idle/expected, or already handling
    _outage.active = true;
    await notifyOwner('⚠️ Verbindung zum Server verloren. Die Aufnahme läuft lokal weiter. Ich versuche, den Server neu zu starten …');
    if (!_outage.autoRestartTried) {
      _outage.autoRestartTried = true;
      let result = 'timeout';
      try { result = await ensureServerReachable({}); }
      catch (e) { warn('outage auto-restart failed:', e.message); }
      // On success the control client (still reconnecting during the session)
      // comes back → the connected:true branch posts the recovery message.
      if (result === 'timeout' || result === 'no-cmd' || result === 'no-base-url') {
        await notifyOwner('❌ Automatischer Server-Neustart fehlgeschlagen. Die Aufnahme läuft lokal weiter. Mit `/server restart` erneut versuchen.');
      }
    }
  } else if (_outage.active) {
    _outage.active = false;
    _outage.autoRestartTried = false;   // a future outage gets a fresh auto-restart
    await notifyOwner('🟢 Server wieder verbunden — Live-Transkription aktiv.');
  }
}

// Dispose all in-flight recorders (e.g. voice reconnect / leave / detach).
function disposeAllRecordings(reason) {
  if (!activeRecordings.size) return;
  debug('disposing', activeRecordings.size, 'recorder(s) —', reason);
  for (const rec of activeRecordings.values()) { try { rec.dispose(); } catch {} }
  activeRecordings.clear();
}

// Build the Custom-Status text shown in the bot's Discord profile.
// With server connected: "1.0.1-d5b717a (server:1.0.1-d5b717a)"
// Without:               "1.0.1-d5b717a"
function makeStatusText(serverVersion) {
  const own = getVersion();
  return serverVersion ? `${own} (server:${serverVersion})` : own;
}

function setBotStatus(serverVersion) {
  if (!client.user) return;
  try {
    client.user.setActivity(makeStatusText(serverVersion), { type: ActivityType.Custom });
  } catch (e) {
    warn('setActivity failed:', e.message);
  }
}

function displayNameFor(member, user) {
  return member?.displayName || member?.nick || user?.globalName || user?.username || user?.id || 'Spieler';
}

// Typed questions keep the on-demand link up until their chat answer is in
// (see answerHolds.js) — the idle release would otherwise drop it first.
const answerHolds = new AnswerHolds({ hold: (reason) => transport.holdLink(reason) });

function askServer({ question, tts = false, channelId, userId, userDisplayName, source = 'slash' }) {
  // Share voice-session history only when the question comes from the same
  // channel the bot is currently joined to. Other text channels keep their
  // own channel-scoped history on the server side.
  const sessionId = (channelId && channelId === _activeVoiceChannelId)
    ? sessions.wireSessionId()
    : null;
  const sent = transport.textQuery({
    sessionId,
    question,
    tts,
    channelId,
    userId,
    userDisplayName,
    source,
  });
  if (sent) answerHolds.add(channelId);
  return sent;
}

// Idle auto-finalize for LEFT sessions (see leaveFinalize.js for why the bot
// and not the server times this). SESSION_IDLE_HOURS after the last activity;
// AUTO_FINALIZE_AFTER_LEAVE=false turns it off (manual /finalize run only).
const leaveFinalizer = new LeaveFinalizeScheduler({
  idleMs: (Number(process.env.SESSION_IDLE_HOURS) || 4) * 3600_000,
  enabled: !/^(0|false|no|off)$/i.test(process.env.AUTO_FINALIZE_AFTER_LEAVE ?? 'true'),
  // Re-joined in the meantime → the session is live again, not idle.
  isBlocked: (id) => !!(sessions.active && sessions.active.id === id && _activeVoiceChannelId),
  run: autoFinalizeLeftSession,
});

async function autoFinalizeLeftSession(id) {
  const session = (sessions.active && sessions.active.id === id) ? sessions.active : SessionManager.loadById(id);
  if (!session || session.status !== SessionStatus.OPEN || _finalizeInFlight.has(id)) return;
  // Nothing recorded → nothing to transcribe. Skip BEFORE performFinalize, which
  // would otherwise bring up (on cloud: launch) a server just to fail.
  if (!(session.timeline?.length > 0)) { log(`leave-finalize: ${id} has no utterances — left open`); return; }
  const { result } = await performFinalize(session, { reason: 'automatisch (Inaktivität nach /leave)' });
  log(`leave-finalize: ${id} finalized → ${result.transcriptPath}`);
}

// On startup: open sessions on disk get the idle countdown re-armed from their
// last activity (already overdue → finalized shortly after start, serialised;
// a /join within the window cancels it and resumes the session instead).
// Sessions stuck in FINALIZING (bot died mid-finalize — nothing can still be
// running after a restart) are put back to OPEN so they can be retried.
function recoverOldSessions() {
  for (const entry of SessionManager.listAll()) {
    if (entry.status !== SessionStatus.FINALIZING) continue;
    const s = SessionManager.loadById(entry.id);
    if (!s) continue;
    s.status = SessionStatus.OPEN;
    SessionManager.save(s);
    warn(`Session ${s.id} hing in FINALIZING (Bot-Neustart während Finalize) — wieder auf OPEN gesetzt.`);
  }
  let open = [];
  try { open = SessionManager.listOpenSessions(); } catch { /* DATA_DIR missing → nothing to recover */ }
  for (const dir of open) {
    const s = SessionManager.loadById(dir.split(/[\\/]/).pop());
    if (!s) continue;
    // ≥ 60 s after start: transport + Discord settle, and an immediate /join wins.
    leaveFinalizer.arm(s.id, s.lastActivity, { minDelayMs: 60_000 });
    log(`Offene Session ${s.id}: Auto-Finalize ${leaveFinalizer.enabled ? 'geplant' : 'aus (AUTO_FINALIZE_AFTER_LEAVE=false) — mit /finalize run abschließen'}.`);
  }
}

client.once('clientReady', async () => {
  log(`Bot v${getVersion()} online als ${client.user.tag}`);
  setBotStatus(null);
  startTranscriptCleanup();
  startArchiveCleanup();
  await recoverOldSessions();
  transport.start({ botId: client.user.id, isSessionActive: hasActiveSession });

  transport.onServerInfo((info) => {
    setBotStatus(info.connected ? info.version : null);
    handleServerLink(info).catch((e) => warn('server-link handler:', e.message));
  });

  transport.onFinalizeRequest((req) => { handleAutoFinalize(req).catch((e) => warn('auto-finalize:', e.message)); });

  transport.onChatMessage(async (msg) => {
    answerHolds.settle(msg.channelId);
    const targetChannel = msg.channelId
      ? await client.channels.fetch(msg.channelId).catch(() => null)
      : _textChannel;
    if (!targetChannel?.send) return;
    // A long answer (a /recap, or a long /ask question + answer) can exceed
    // Discord's 2000-char limit — one oversized send was rejected and the
    // answer lost. Post it in order as several messages instead.
    for (const part of splitDiscordMessage(chatMessageText(msg))) {
      try { await targetChannel.send(part); }
      catch (e) { warn('chat_message send failed:', e.message); return; }
    }
  });
});

// Detach the active in-memory session and tear down its voice connection.
function detachActiveSession() {
  disposeAllRecordings('detach');
  // Tell the server the bot left voice (stops clock_sync logging).
  const wid = sessions.wireSessionId();
  if (wid) transport.voiceState({ sessionId: wid, state: 'left' });
  transport.clearVoiceConnection();
  const ch = _activeVoiceChannelId ? client.channels.cache.get(_activeVoiceChannelId) : null;
  const conn = ch?.guild ? getVoiceConnection(ch.guild.id) : null;
  if (conn) { try { conn.destroy(); } catch {} }
  sessions.active = null;
  _activeVoiceChannelId = null;
  _outage.active = false;
  _outage.autoRestartTried = false;
  // Session is over → drop the server link after a short grace (flushes the
  // 'left' above and survives an immediate re-/join).
  maybeScheduleIdleRelease();
}

// Bring the control link up for a finalize. The link is opened lazily and
// released 60 s after the last voice session, so a /finalize run after /leave
// almost always starts without one (and a server-requested auto-finalize can
// find it gone again after a server hiccup). Previously finalize never
// reconnected: it failed with "Server nicht verbunden" and only a /join (+
// /leave) brought the link back. Mirrors /join and /server restart: try the
// link; if that fails, make sure the server is up (SERVER_START_CMD when
// configured) and try again. Throws a user-facing error when the server stays
// unreachable.
async function ensureFinalizeLink(onProgress = () => {}) {
  if (transport.isConnected()) return;
  onProgress('⏳ Verbinde mit dem Server …');
  try { await transport.ensureConnected({ timeoutMs: 12000 }); return; }
  catch (e) { debug('finalize: control link not ready:', e.message); }

  let result = 'timeout';
  try {
    result = await ensureServerReachable({
      onProgress: ({ phase, elapsedMs, deadlineMs }) => onProgress(phase === 'starting'
        ? '⏳ Server offline – starte ihn …'
        : `⏳ Warte bis Server bereit ist (${Math.round(elapsedMs / 1000)}s/${Math.round(deadlineMs / 1000)}s) …`),
    });
  } catch (e) { warn('finalize: ensureServerReachable failed:', e.message); }
  if (result === 'started' || result === 'already-online') {
    try { await transport.ensureConnected({ timeoutMs: 12000 }); return; }
    catch (e) { debug('finalize: control link still not ready:', e.message); }
  }
  throw new Error(result === 'no-cmd'
    ? 'Server nicht erreichbar (kein Auto-Start konfiguriert). Session bleibt offen – später erneut mit `/finalize run` versuchen.'
    : 'Server nicht erreichbar. Session bleibt offen – später erneut mit `/finalize run` versuchen (ggf. vorher `/server restart`).');
}

// Live Discord status message per running finalize (session id → FinalizeStatus).
const _finalizeStatuses = new Map();

// Where a finalize reports: the channel the command came from, else the text
// channel bound at /join (persisted in session.json, so it survives a bot
// restart for auto-finalizes), else the last known text channel.
async function resolveSessionTextChannel(session, preferred = null) {
  if (preferred?.send) return preferred;
  if (session?.textChannelId) {
    const ch = await client.channels.fetch(session.textChannelId).catch(() => null);
    if (ch?.send) return ch;
  }
  return _textChannel?.send ? _textChannel : null;
}

// Session ids with a performFinalize in flight. The persisted FINALIZING
// status is only set once the link is up (so an unreachable server leaves the
// session untouched); this closes the window before that against a second
// /finalize run or a racing auto-finalize for the same session.
const _finalizeInFlight = new Set();

// Shared finalize flow for both manual (/finalize run) and server-initiated
// (idle auto-finalize) paths: link → lock → manifest → upload → server
// finalize → status + checksum-gated retention → detach if active. Throws on
// failure (status reverted / never changed, so it can be retried).
async function performFinalize(session, opts = {}) {
  if (_finalizeInFlight.has(session.id)) throw new Error('Diese Session wird bereits finalisiert.');
  _finalizeInFlight.add(session.id);
  // Finalize needs the server alive (upload + STT + transcript build). Cancel
  // any pending idle auto-stop so it can't fire mid-finalize — this also covers
  // a finalize started after /leave, when the stop was already armed.
  cancelServerStop();
  // It also needs the control link for its whole duration (finalize_session
  // and its reply). Hold it: otherwise the idle release armed by /leave (60 s
  // grace) drops the socket in the middle of a re-STT that runs for minutes.
  const releaseLink = transport.holdLink(`finalize ${session.id}`);
  // Live status in the session's text channel: bot-side steps (connect,
  // upload) and the server's finalize_progress (x/N utterances, merge, audio),
  // then the result or the error. Survives the 15-min interaction-token limit
  // and covers auto-finalizes, which have no interaction at all.
  const status = new FinalizeStatus({
    resolveChannel: () => resolveSessionTextChannel(session, opts.channel),
    header: `🗄️ **Finalize** Session \`${session.id}\`${opts.reason ? ` — ${opts.reason}` : ''}`,
  });
  _finalizeStatuses.set(session.id, status);
  const wireId = String(session.startedAt);
  const offProgress = transport.onFinalizeProgress((m) => {
    if (String(m?.sessionId) === wireId) status.update(formatProgress(m));
  });
  const onProgress = (text) => { status.update(text); opts.onProgress?.(text); };
  await status.start('⏳ Startet …');
  try {
    // Before touching status/manifest/upload: an unreachable server must leave
    // the session exactly as it was, so /finalize run can simply be retried.
    await ensureFinalizeLink(onProgress);
    const out = await runFinalize(session, { ...opts, onProgress });
    await status.done(finalizeResultText(out.result, out.retentionNote, { reFinalize: opts.fromArchive, maxChars: status.textRoom() }));
    return out;
  } catch (e) {
    await status.fail(`❌ Finalize fehlgeschlagen: ${e.message}\nDie lokalen Aufnahmen bleiben erhalten — erneut mit \`/finalize run session:${session.id}\`.`);
    throw e;
  } finally {
    offProgress?.();
    _finalizeStatuses.delete(session.id);
    _finalizeInFlight.delete(session.id);
    // Last hold gone → the normal idle policy applies again: with no active
    // session the link is released after the grace period.
    releaseLink();
    // Finalize is done (success or failure) → re-arm the idle auto-stop. A
    // finalize started after /leave (session already detached, so nothing else
    // re-arms it) would otherwise leave the cloud server running indefinitely.
    // The hasWork re-check at fire time skips the stop if a session is live.
    scheduleServerStop({ hasWork: hasServerWork });
  }
}

// performFinalize's body, run with the control link up and held.
async function runFinalize(session, { channelName = null, guildName = null, onProgress = () => {}, fromArchive = false } = {}) {
  const prevStatus = session.status;
  session.status = SessionStatus.FINALIZING;
  SessionManager.save(session);
  try {
    let result;
    if (fromArchive) {
      // Re-finalize: no upload — the server rebuilds from the archived originals.
      onProgress('⏳ Server finalisiert aus dem Archiv neu …');
      result = await transport.finalizeSession({ sessionId: String(session.startedAt), sessionName: session.id });
    } else {
      const manifest = buildManifest(session, {
        channelName,
        guildName,
        wakeWord: process.env.WAKE_WORD ?? 'Rabenauge',
        botVersion: getVersion(),
      });
      if (manifest.utterances.length === 0) throw new Error('Session enthält keine aufgenommenen Äußerungen.');
      writeManifest(session, manifest);

      onProgress(`⏳ Lade ${manifest.utterances.length} Audiodateien zum Server …`);
      // Ensure the server-side upload dir exists (scp won't create it remotely).
      try { await transport.finalizePrepare(manifest.sessionId); }
      catch (e) { warn('finalize: prepare failed (continuing):', e.message); }
      await uploadSession(session);

      onProgress('⏳ Server transkribiert und baut das Transkript …');
      result = await transport.finalizeSession({ sessionId: manifest.sessionId, sessionName: session.id });
    }
    if (!result.ok) throw new Error(result.error || 'Finalize fehlgeschlagen');

    const fullyVerified = (result.missing?.length ?? 0) === 0 && (result.mismatched?.length ?? 0) === 0;
    session.status = SessionStatus.FINALIZED;
    session.finalizedAt = Date.now();
    session.finalize = { transcriptPath: result.transcriptPath, archiveDir: result.archiveDir, userCount: result.userCount };
    SessionManager.save(session);

    // Pull the finished archive back onto the persistent bot host immediately —
    // on a cloud instance the archive dies with the box at auto-stop, and the
    // instance can only reach Proxmox (not the bot), so the bot must pull. Purely
    // additive: a failure here NEVER kips the finalize result (stop.sh --backup
    // stays as the safety net), it only annotates the status line.
    let archiveNote = '';
    if (result.archiveName) {
      try {
        const pull = await pullArchive({ archiveName: result.archiveName });
        if (pull && pull.ok) {
          archiveNote = ` 📦 Archiv lokal gesichert (${pull.files} Dateien).`;
        } else if (pull && !pull.skipped) {
          archiveNote = ` ⚠️ Archiv-Pull unvollständig (${pull.failed?.length ?? 0} Datei(en) fehlgeschlagen) — stop.sh --backup bleibt als Netz.`;
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
      const r = applyRetention(session);
      retentionNote = r.noop ? '' : (r.policy === 'delete' ? ' Lokale WAVs gelöscht (Original liegt im Server-Archiv).' : ' Lokale WAVs ins _archived/ verschoben.');
    } else {
      retentionNote = ` ⚠️ ${result.missing?.length ?? 0} fehlende / ${result.mismatched?.length ?? 0} fehlerhafte Uploads – lokale WAVs bleiben für erneuten Versuch erhalten.`;
    }

    if (sessions.active && sessions.active.id === session.id) detachActiveSession();
    // Finalized = over for the server link too (no revival on the next
    // reconnect, later /recap not logged into this session).
    transport.endSessionIfCurrent(String(session.startedAt));
    return { result, fullyVerified, retentionNote: retentionNote + archiveNote };
  } catch (e) {
    session.status = prevStatus;
    SessionManager.save(session);
    throw e;
  }
}

// Server-initiated finalize (idle timeout). The server decided the timing; the
// bot owns the WAVs and runs the flow. Race guard: if the targeted session is
// still active with humans present in voice, activity resumed → skip.
async function handleAutoFinalize({ sessionId }) {
  const session = (sessions.active && String(sessions.active.startedAt) === String(sessionId))
    ? sessions.active
    : SessionManager.findByWireId(sessionId);
  if (!session) { warn('auto-finalize: unknown session', sessionId); return; }
  if (session.status === SessionStatus.FINALIZING || session.status === SessionStatus.FINALIZED) return;
  if (_finalizeInFlight.has(session.id)) return; // manual finalize still bringing up the link

  if (sessions.active && sessions.active.id === session.id && _activeVoiceChannelId) {
    const ch = client.channels.cache.get(_activeVoiceChannelId);
    const humans = ch ? [...ch.members.values()].filter((m) => !m.user.bot).length : 0;
    if (humans > 0) { log('auto-finalize: humans present, skipping', sessionId); return; }
  }

  log('auto-finalize: finalizing idle session', session.id);
  try {
    // Result and errors show up in the session's status message (performFinalize).
    await performFinalize(session, { reason: 'automatisch (Inaktivität)' });
  } catch (e) {
    warn('auto-finalize failed:', e.message);
  }
}

client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'ask' || i.commandName === 'recap') {
      _textChannel = i.channel;
      // /recap is a fixed question: the server hands the LLM the last finalized
      // session's summary as context (LAST_SESSION_CONTEXT_*), so this works in
      // and outside a voice session — on request only, never as a greeting.
      const question = i.commandName === 'recap'
        ? 'Fasse kurz zusammen, was in unserer letzten Sitzung passiert ist und wo die Gruppe steht.'
        : i.options.getString('frage', true).trim();
      if (!question) {
        return i.reply({ content: 'Bitte eine Frage angeben.', flags: MessageFlags.Ephemeral });
      }
      const tts = i.options.getBoolean('tts') ?? false;
      const member = i.member;

      // The control link is only kept open during a voice session, so open it
      // on demand here. May take a moment → defer first.
      if (!transport.isConnected()) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        try { await transport.ensureConnected({ timeoutMs: 12000 }); }
        catch {
          maybeScheduleIdleRelease();
          return i.editReply('Server nicht erreichbar. Mit `/join` starten oder `/server restart`.');
        }
      }

      const sent = askServer({
        question,
        tts,
        channelId: i.channelId,
        userId: i.user.id,
        userDisplayName: displayNameFor(member, i.user),
        source: 'slash',
      });
      // No active voice session → drop the link again after a short idle grace.
      maybeScheduleIdleRelease();
      const content = !sent
        ? 'Server ist noch nicht verbunden. Bitte gleich erneut versuchen oder /join nutzen.'
        : (tts ? 'Frage gesendet. Antwort wird auch vorgelesen.' : 'Frage gesendet.');
      return i.deferred ? i.editReply(content) : i.reply({ content, flags: MessageFlags.Ephemeral });
    }

    if (i.commandName === 'server') {
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        const connected = transport.isConnected();
        const ver = transport.serverVersion();
        return i.reply({
          content: connected ? `🟢 Server verbunden${ver ? ` (v${ver})` : ''}.` : '🔴 Keine Server-Verbindung.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (sub === 'restart') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        let result = 'timeout';
        try {
          result = await ensureServerReachable({
            onProgress: ({ phase, elapsedMs, deadlineMs }) => {
              const msg = phase === 'starting'
                ? '⏳ Starte Server per SSH …'
                : `⏳ Warte bis Server bereit ist (${Math.round(elapsedMs / 1000)}s/${Math.round(deadlineMs / 1000)}s) …`;
              i.editReply({ content: msg }).catch(() => {});
            },
          });
        } catch (e) { warn('/server restart:', e.message); }

        if (result === 'started' || result === 'already-online') {
          _outage.active = false;
          _outage.autoRestartTried = false;
          try { await transport.ensureConnected({ timeoutMs: 12000 }); } catch { /* will reconnect */ }
          maybeScheduleIdleRelease();
          return i.editReply(transport.isConnected()
            ? '🟢 Server läuft und ist verbunden.'
            : '🟢 Server gestartet — Verbindung wird aufgebaut.');
        }
        return i.editReply(result === 'no-cmd' || result === 'no-base-url'
          ? '❌ Kein Auto-Start konfiguriert (SERVER_START_CMD fehlt).'
          : '❌ Server-Start fehlgeschlagen (Timeout).');
      }
      return;
    }

    if (i.commandName === 'join') {
      // A (re-)join means the server is wanted → cancel any pending idle
      // auto-stop before the background ensureServerReachable kicks off, so a
      // re-join within the stop window keeps the server alive.
      cancelServerStop();
      _textChannel = i.channel;
      // Remember who started the session (for outage notifications) and reset
      // any stale outage state from a previous session.
      _sessionOwner = { interaction: i, userId: i.user.id };
      _outage.active = false;
      _outage.autoRestartTried = false;
      const member = await i.guild.members.fetch(i.user.id);
      const channel = member.voice.channel;
      if (!channel) return i.reply({ content: 'Du bist in keinem Voice-Channel.', flags: MessageFlags.Ephemeral });

      // Cloud cold-starts can take minutes (SERVER_START_TIMEOUT_MS) — defer
      // the reply so Discord doesn't time out the interaction (3 s limit for
      // non-deferred replies).
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      // Join and start recording immediately — never block on the server.
      // Offline recording already works (server only adds STT/LLM/live-view
      // features), so there's no reason to make the user wait minutes for a
      // cold cloud instance just to join voice.
      //
      // `otherLines` holds the join/session status (set once, below);
      // `serverStatusLine` holds the latest server auto-start status and is
      // updated asynchronously by the background ensureServerReachable
      // call. Both are re-rendered together on every change so one never
      // clobbers the other in the single editReply-able message.
      const otherLines = [];
      let serverStatusLine = null;
      const renderStatus = () => {
        const lines = [...otherLines];
        if (serverStatusLine) lines.push(serverStatusLine);
        i.editReply({ content: lines.join('\n') }).catch(() => {});
      };

      ensureServerReachable({
        onProgress: ({ phase, elapsedMs, deadlineMs, cmdStatus }) => {
          if (phase === 'starting') {
            serverStatusLine = '⏳ Server offline – starte ihn im Hintergrund …';
          } else {
            const sec = Math.round(elapsedMs / 1000);
            const total = Math.round(deadlineMs / 1000);
            serverStatusLine = `⏳ Warte bis Server bereit ist (${sec}s/${total}s) …`;
            if (cmdStatus?.message) {
              serverStatusLine += `\n> ${cmdStatus.message}`;
            }
          }
          renderStatus();
        },
      }).then((startResult) => {
        if (startResult === 'started') {
          log('join: server auto-started successfully');
          serverStatusLine = '🟢 Server gestartet.';
        } else if (startResult === 'no-cmd') {
          warn('join: server offline, no SERVER_START_CMD — continuing in offline mode');
          serverStatusLine = '⚠️ Server offline (kein Auto-Start konfiguriert) – Aufnahme läuft lokal.';
        } else if (startResult === 'timeout') {
          warn('join: server did not come up — continuing in offline mode');
          serverStatusLine = '⚠️ Server-Start fehlgeschlagen (Timeout) – Aufnahme läuft lokal.';
          // The watchdog (transport/index.js) keeps retrying independently after
          // this point. Mark an outage so handleServerLink's existing recovery
          // path (a fresh ephemeral "server wieder verbunden") fires once it
          // eventually succeeds — otherwise this message is left stale forever
          // even though the connection quietly came up moments later.
          _outage.active = true;
        } else {
          return; // 'already-online' / 'no-base-url' — no extra status line
        }
        renderStatus();
      }).catch((err) => warn('join: ensureServerReachable failed:', err.message));

      // Open the control link for this session (lazy — closed again on /leave).
      // Don't block the join on it: if it isn't ready in time we still join and
      // record locally; the control client keeps reconnecting during the session.
      try { await transport.ensureConnected({ timeoutMs: 12000 }); }
      catch (e) { debug('join: control link not ready yet:', e.message); }

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      // Official recommended disconnect handler: distinguish a channel redirect
      // (recovers within 5 s) from a real disconnect that needs cleanup.
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Reconnecting to a new voice server — nothing to do.
        } catch {
          // Did not recover — real disconnect.
          warn('voice: real disconnect, destroying connection');
          try { connection.destroy(); } catch {}
          // Treat it like an implicit /leave (kicked, channel deleted, network
          // gone): without this the session was neither reported as left nor
          // armed for idle auto-finalize, and the server link stayed open.
          disposeAllRecordings('voice disconnect');
          transport.clearVoiceConnection();
          const wid = sessions.wireSessionId();
          if (wid) transport.voiceState({ sessionId: wid, state: 'left' });
          _activeVoiceChannelId = null;
          if (sessions.active) leaveFinalizer.arm(sessions.active.id, sessions.active.lastActivity);
          maybeScheduleIdleRelease();
        }
      });

      connection.on('stateChange', (oldState, newState) => {
        debug('voice:', oldState.status, '->', newState.status);
        if (newState.status === VoiceConnectionStatus.Ready) {
          log('voice: ready — receiver active');
        } else if (oldState.status === VoiceConnectionStatus.Ready) {
          // Left READY (voice reconnect / move / disconnect): the decryption
          // context of any in-flight receive stream is now stale and would
          // yield corrupt Opus. Tear the recorders down; fresh speaking.start
          // events after READY re-subscribe with the new secret key.
          disposeAllRecordings('voice left READY');
        }
      });

      connection.on('error', (e) => warn('voice: connection error:', e.message));

      // Back in voice: no pending idle auto-finalize may hit the (resumed) session.
      leaveFinalizer.cancelAll();
      const { resumed } = sessions.resumeOrStart();
      _activeVoiceChannelId = channel.id;
      // Remember where this session talks — finalize status messages (also
      // auto-finalizes after a bot restart) go to this channel.
      if (sessions.active && i.channelId && sessions.active.textChannelId !== i.channelId) {
        sessions.active.textChannelId = i.channelId;
        SessionManager.save(sessions.active);
      }
      transport.sessionStart({
        sessionId: sessions.wireSessionId(),
        guildId: channel.guild.id,
        guildName: channel.guild.name,
        channelId: channel.id,
        channelName: channel.name,
        botVersion: getVersion(),
        startedAt: sessions.active.startedAt,
        resume: resumed,
      });
      // Tell the server the bot is present in voice (drives the server-side
      // auto-finalize idle timer).
      transport.voiceState({ sessionId: sessions.wireSessionId(), state: 'joined' });
      // Record current channel members as joined (they don't trigger a
      // voiceStateUpdate for this /join).
      for (const m of channel.members.values()) {
        if (m.user.bot) continue;
        transport.voiceMember({ sessionId: sessions.wireSessionId(), userId: m.id, displayName: m.displayName, state: 'join' });
      }
      transport.setVoiceConnection(connection);

      // Minimal streaming-TTS smoke test.  This uses the real server→bot
      // downlink, but the new FIFO playback path: no jitter timestamps, no gate,
      // no DTX silence frames.
      {
        let sent = false;
        const triggerDebugTts = () => {
          if (sent) return;
          sent = true;
          setTimeout(() => {
            log('debug_tts: requesting minimal streaming TTS test');
            transport.debugTts({ sessionId: sessions.wireSessionId() });
          }, 1000);
        };
        if (connection.state.status === VoiceConnectionStatus.Ready) {
          triggerDebugTts();
        } else {
          const onReady = (_oldState, newState) => {
            if (newState.status !== VoiceConnectionStatus.Ready) return;
            connection.off('stateChange', onReady);
            triggerDebugTts();
          };
          connection.on('stateChange', onReady);
        }
      }

      const receiver = connection.receiver;

      receiver.speaking.on('start', (userId) => {
        debug('speaking: start userId=', userId);
        if (userId === client.user.id) return; // bot's own voice, ignore
        // Only subscribe once the voice connection is READY. Packets received
        // before the secret key is established (e.g. speaking events that fire
        // during 'connecting') decrypt to garbage → corrupt Opus → crash.
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
          debug('speaking: ignoring start (voice not ready) for', userId);
          return;
        }
        transport.speakingStart(userId);
        if (activeRecordings.has(userId)) {
          debug('already recording, skip start for', userId);
          return;
        }
        const discordUser = client.users.cache.get(userId) || { id: userId, username: 'unknown' };
        const guildMember = channel.guild.members.cache.get(userId);
        const user = {
          id: userId,
          username: displayNameFor(guildMember, discordUser),
        };
        const rec = new UtteranceRecorder(sessions.active, connection, receiver, user, {
          silenceMs: 1500,
          onChunkDone: (u) => {
            sessions.addUtterance(u);
            sessions.persist();
            debug('chunk saved:', u.file, u.durationMs + 'ms');
          }
        });
        activeRecordings.set(userId, rec);
        // subscribe() never rejects (errors end the chunk gracefully); .catch is
        // a belt-and-suspenders guard so a stray rejection can never crash.
        rec.subscribe()
          .catch((e) => warn('recorder failed for', userId, e.message))
          .finally(() => { if (activeRecordings.get(userId) === rec) activeRecordings.delete(userId); });
      });

      receiver.speaking.on('end', (userId) => {
        if (userId === client.user.id) return; // bot's own voice, ignore
        transport.speakingEnd(userId);
      });

      otherLines.push(resumed
        ? `Verbunden mit **${channel.name}**. Session **fortgesetzt** (\`${sessions.active.id}\`).`
        : `Verbunden mit **${channel.name}**. Aufnahme läuft (neue Session \`${sessions.active.id}\`).`);

      // Reminder: speakers currently in the channel without a mapping (best
      // effort — needs the server online; falls back silently otherwise).
      try {
        const map = await transport.getSpeakerMap(channel.guild.id);
        const unmapped = [...channel.members.values()]
          .filter((m) => !m.user.bot && !map[m.id])
          .map((m) => m.displayName);
        if (unmapped.length) {
          otherLines.push(`ℹ️ Ohne Sprecher-Zuordnung: ${unmapped.join(', ')} — mit \`/finalize map\` zuordnen (sonst wird der Anzeigename verwendet).`);
        }
      } catch { /* server offline — skip reminder */ }

      renderStatus();
    }

    if (i.commandName === 'leave') {
      const conn = getVoiceConnection(i.guildId);
      if (conn) conn.destroy();
      disposeAllRecordings('leave');
      transport.clearVoiceConnection();
      // Leaving voice does NOT end the session. Recording resumes on the next
      // /join within the idle window; finalize (manual /finalize or the idle
      // auto-finalize armed here) owns session teardown.
      const wireId = sessions.wireSessionId();
      if (wireId) transport.voiceState({ sessionId: wireId, state: 'left' });
      sessions.touch();
      if (sessions.active) leaveFinalizer.arm(sessions.active.id, sessions.active.lastActivity);
      _activeVoiceChannelId = null;
      _outage.active = false;
      _outage.autoRestartTried = false;
      // Idle now (no voice session) → drop the server link after a short grace
      // (lets the 'left' above flush and survives an immediate re-/join).
      maybeScheduleIdleRelease();
      await i.reply({
        content: 'Voice-Channel verlassen. Session bleibt offen – mit `/join` fortsetzen oder via `/finalize` abschließen (sonst automatisch nach Inaktivität).',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (i.commandName === 'finalize') {
      const sub = i.options.getSubcommand();

      if (sub === 'list') {
        const all = SessionManager.listAll();
        if (all.length === 0) return i.reply({ content: 'Keine Sessions vorhanden.', flags: MessageFlags.Ephemeral });
        const lines = all.slice(0, 20).map((s) => {
          const when = new Date(s.startedAt).toLocaleString('de-DE');
          const active = sessions.active && sessions.active.id === s.id ? ' ◀ aktiv' : '';
          return `• \`${s.id}\` — ${s.status}, ${s.utterances} Äußerungen, ${when}${active}`;
        });
        return i.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
      }

      if (sub === 'show') {
        const id = i.options.getString('session', true);
        const s = (sessions.active && sessions.active.id === id) ? sessions.active : SessionManager.loadById(id);
        if (!s) return i.reply({ content: `Session \`${id}\` nicht gefunden.`, flags: MessageFlags.Ephemeral });
        const lines = [
          `**Session \`${s.id}\`**`,
          `Status: ${s.status}`,
          `Start: ${new Date(s.startedAt).toLocaleString('de-DE')}`,
          `Äußerungen: ${(s.timeline || []).length}`,
        ];
        if (s.finalize) {
          lines.push(`Transkript: \`${s.finalize.transcriptPath}\``);
          lines.push(`Archiv: \`${s.finalize.archiveDir}\``);
        }
        return i.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
      }

      if (sub === 'map') {
        const guildId = i.guildId;
        const user = i.options.getUser('user');
        if (!user) {
          let map;
          try { map = await transport.getSpeakerMap(guildId); }
          catch { return i.reply({ content: 'Server nicht verbunden – Zuordnungen liegen serverseitig.', flags: MessageFlags.Ephemeral }); }
          const entries = Object.entries(map);
          if (entries.length === 0) return i.reply({ content: 'Keine Sprecher-Zuordnungen. Setzen mit `/finalize map user:@… player:…`.', flags: MessageFlags.Ephemeral });
          const lines = entries.map(([uid, e]) =>
            `• <@${uid}> → **${e.player ?? '—'}**${e.character ? ` (${e.character})` : ''}${e.phonetic ? ` _[${e.phonetic}]_` : ''}`);
          return i.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
        }
        const player = i.options.getString('player');
        const character = i.options.getString('character');
        const phonetic = i.options.getString('phonetic');
        if (!player && !character && !phonetic) {
          let map = {};
          try { map = await transport.getSpeakerMap(guildId); } catch { /* offline */ }
          const e = map[user.id];
          return i.reply({
            content: e ? `<@${user.id}> → **${e.player ?? '—'}**${e.character ? ` (${e.character})` : ''}${e.phonetic ? ` _[${e.phonetic}]_` : ''}`
                       : `Keine Zuordnung für <@${user.id}>. Setzen: \`/finalize map user:@… player:…\`.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        const entry = {};
        if (player) entry.player = player;
        if (character) entry.character = character;
        if (phonetic) entry.phonetic = phonetic;
        try {
          await transport.setSpeakerMapping(guildId, user.id, entry);
        } catch (e) {
          return i.reply({ content: `Konnte Zuordnung nicht speichern: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
        return i.reply({
          content: `✅ Zuordnung gespeichert: <@${user.id}> → **${player ?? '—'}**${character ? ` (${character})` : ''}${phonetic ? ` _[${phonetic}]_` : ''}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // sub === 'run'
      const idArg = i.options.getString('session');
      let session;
      if (idArg) {
        session = (sessions.active && sessions.active.id === idArg) ? sessions.active : SessionManager.loadById(idArg);
      } else {
        session = sessions.active;
      }
      if (!session) return i.reply({ content: 'Keine Session zum Finalisieren (gib eine Session-ID an oder starte mit /join).', flags: MessageFlags.Ephemeral });
      if (session.status === SessionStatus.FINALIZING || _finalizeInFlight.has(session.id)) {
        return i.reply({ content: 'Diese Session wird bereits finalisiert.', flags: MessageFlags.Ephemeral });
      }
      // FINALIZED sessions may be re-finalized (rebuilds from the retained
      // _archived WAVs) — useful after code changes. uploadSession/buildManifest
      // resolve the source dir automatically (live or archived).
      const reFinalize = session.status === SessionStatus.FINALIZED;

      await i.deferReply({ flags: MessageFlags.Ephemeral });
      // Progress + result live in a channel message (see performFinalize); the
      // ephemeral reply only points there. Its final edit is best-effort — the
      // interaction token is dead after 15 min.
      await i.editReply({ content: `⏳ Finalize gestartet — Fortschritt im Kanal ${i.channel ? `<#${i.channelId}>` : ''}.` }).catch(() => {});
      try {
        const { result, retentionNote } = await performFinalize(session, {
          channelName: i.channel?.name ?? null,
          guildName: i.guild?.name ?? null,
          channel: i.channel,
          fromArchive: reFinalize,
          reason: reFinalize ? 'neu (aus dem Archiv)' : null,
        });
        await i.editReply({ content: finalizeResultText(result, retentionNote, { reFinalize }) }).catch(() => {});
      } catch (e) {
        error(e);
        await i.editReply({ content: `❌ Finalize fehlgeschlagen: ${e.message}` }).catch(() => {});
      }
    }
  } catch (e) {
    error(e);
    try { await (i.deferred || i.replied ? i.followUp('Fehler.') : i.reply('Fehler.')); } catch {}
  }
});

// Track voice-channel presence in the active channel and report it to the
// server so it can (re)arm or cancel the idle auto-finalize timer. The bot
// being alone (no humans) arms it; a human present cancels it.
client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    if (!_activeVoiceChannelId || !sessions.active) return;
    const wid = sessions.wireSessionId();

    // Per-user join/leave to/from our channel → participant times.
    const member = newState.member ?? oldState.member;
    const uid = member?.id;
    if (uid && uid !== client.user.id) {
      const joined = oldState.channelId !== _activeVoiceChannelId && newState.channelId === _activeVoiceChannelId;
      const leftCh = oldState.channelId === _activeVoiceChannelId && newState.channelId !== _activeVoiceChannelId;
      if (joined || leftCh) {
        transport.voiceMember({ sessionId: wid, userId: uid, displayName: displayNameFor(member, member?.user), state: joined ? 'join' : 'leave' });
      }
    }

    if (oldState.channelId !== _activeVoiceChannelId && newState.channelId !== _activeVoiceChannelId) return;
    const channel = client.channels.cache.get(_activeVoiceChannelId);
    if (!channel) return;
    const humans = [...channel.members.values()].filter((m) => !m.user.bot).length;
    transport.voiceState({ sessionId: wid, state: humans === 0 ? 'alone' : 'occupied' });
  } catch (e) {
    debug('voiceStateUpdate handler error:', e.message);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (!client.user || message.author?.bot) return;
    if (!message.mentions.users.has(client.user.id)) return;

    const mentionRe = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRe, '').replace(/^[\s,;:!?]+/, '').trim();
    if (!question) return;

    _textChannel = message.channel;
    // Control link is opened lazily — establish it on demand for this query.
    if (!transport.isConnected()) {
      try { await transport.ensureConnected({ timeoutMs: 12000 }); }
      catch {
        maybeScheduleIdleRelease();
        await message.reply('Server nicht erreichbar. Mit `/join` starten oder `/server restart`.');
        return;
      }
    }
    const sent = askServer({
      question,
      tts: false,
      channelId: message.channelId,
      userId: message.author.id,
      userDisplayName: displayNameFor(message.member, message.author),
      source: 'mention',
    });
    maybeScheduleIdleRelease();
    if (!sent) {
      await message.reply('Server ist noch nicht verbunden. Bitte gleich erneut versuchen oder /join nutzen.');
    }
  } catch (e) {
    warn('messageCreate ask failed:', e.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
