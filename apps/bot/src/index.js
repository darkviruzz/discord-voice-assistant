import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { Client, GatewayIntentBits, Partials, MessageFlags, ActivityType } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { log, warn, error, debug } from './logger.js';
import { SessionManager } from './session.js';
import { UtteranceRecorder } from './recorder.js';
import { mixSession } from './mixer.js';
import { getVersion } from './version.js';
import { ensureServerReachable } from './serverAutoStart.js';
import * as transport from './transport/index.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel]
});

const sessions = new SessionManager();
const activeRecordings = new Map();
let _textChannel = null;

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

async function recoverOldSessions() {
  const stale = SessionManager.tryAutoFinalizeOld();
  for (const s of stale) {
    try {
      log('Auto-Finalize alter Session:', s.id);
      await mixSession(s.dir, 'session_mix.ogg', s.timeline);
      s.status = 'closed';
      fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify(s, null, 2));
    } catch (e) {
      warn('Auto-Finalize fehlgeschlagen:', e.message);
    }
  }
}

client.once('clientReady', async () => {
  log(`Bot v${getVersion()} online als ${client.user.tag}`);
  setBotStatus(null);
  await recoverOldSessions();
  transport.start({ botId: client.user.id });

  transport.onServerInfo((info) => {
    setBotStatus(info.connected ? info.version : null);
  });

  transport.onChatMessage((msg) => {
    if (!_textChannel) return;
    let text;
    if (msg.isStop) {
      text = `**[Spieler]** ${msg.question}\n⏹ *Wiedergabe unterbrochen.*`;
    } else {
      text = `**[Spieler]** ${msg.question}\n**[Rabenauge]** ${msg.answer ?? ''}`;
    }
    _textChannel.send(text).catch((e) => warn('chat_message send failed:', e.message));
  });
});

client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'join') {
      _textChannel = i.channel;
      const member = await i.guild.members.fetch(i.user.id);
      const channel = member.voice.channel;
      if (!channel) return i.reply({ content: 'Du bist in keinem Voice-Channel.', flags: MessageFlags.Ephemeral });

      // Auto-start can take up to ~30 s — defer the reply so Discord doesn't
      // time out the interaction (3 s limit for non-deferred replies).
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      // Collect status lines so warnings stay visible in the final reply
      // (a single editReply at the end would otherwise overwrite them).
      const statusLines = [];

      const startResult = await ensureServerReachable({
        onProgress: ({ phase, elapsedMs, deadlineMs }) => {
          let msg;
          if (phase === 'starting') {
            msg = '⏳ Server offline – starte ihn per SSH …';
          } else {
            const sec = Math.round(elapsedMs / 1000);
            const total = Math.round(deadlineMs / 1000);
            msg = `⏳ Warte bis Server bereit ist (${sec}s/${total}s) …`;
          }
          i.editReply({ content: msg }).catch(() => {});
        },
      });
      if (startResult === 'started') {
        log('join: server auto-started successfully');
        statusLines.push('🟢 Server gestartet.');
      } else if (startResult === 'no-cmd') {
        warn('join: server offline, no SERVER_START_CMD — continuing in offline mode');
        statusLines.push('⚠️ Server offline (kein Auto-Start konfiguriert) – Aufnahme läuft lokal.');
      } else if (startResult === 'timeout') {
        warn('join: server did not come up — continuing in offline mode');
        statusLines.push('⚠️ Server-Start fehlgeschlagen (Timeout) – Aufnahme läuft lokal.');
      }
      // 'already-online' and 'no-base-url' produce no extra status line.

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
        }
      });

      connection.on('stateChange', (oldState, newState) => {
        debug('voice:', oldState.status, '->', newState.status);
        if (newState.status === VoiceConnectionStatus.Ready) {
          log('voice: ready — receiver active');
        }
      });

      connection.on('error', (e) => warn('voice: connection error:', e.message));

      sessions.loadOrStartNew();
      transport.sessionStart({
        sessionId: sessions.wireSessionId(),
        guildId: channel.guild.id,
        channelId: channel.id,
        startedAt: sessions.active.startedAt,
      });
      transport.setVoiceConnection(connection);

      const receiver = connection.receiver;

      receiver.speaking.on('start', (userId) => {
        debug('speaking: start userId=', userId);
        if (userId === client.user.id) return; // bot's own voice, ignore
        transport.speakingStart(userId);
        if (activeRecordings.has(userId)) {
          debug('already recording, skip start for', userId);
          return;
        }
        const user = client.users.cache.get(userId) || { id: userId, username: 'unknown' };
        const rec = new UtteranceRecorder(sessions.active, connection, receiver, user, {
          silenceMs: 1500,
          onChunkDone: (u) => {
            sessions.addUtterance(u);
            sessions.persist();
            debug('chunk saved:', u.file, u.durationMs + 'ms');
          }
        });
        const p = rec.subscribe()
          .finally(() => activeRecordings.delete(userId));
        activeRecordings.set(userId, p);
      });

      receiver.speaking.on('end', (userId) => {
        if (userId === client.user.id) return; // bot's own voice, ignore
        transport.speakingEnd(userId);
      });

      statusLines.push(`Verbunden mit **${channel.name}**. Aufnahme läuft (Session ${sessions.wireSessionId()}).`);
      await i.editReply({ content: statusLines.join('\n') });
    }

    if (i.commandName === 'leave') {
      const conn = getVoiceConnection(i.guildId);
      if (conn) conn.destroy();
      transport.clearVoiceConnection();
      const wireId = sessions.wireSessionId();
      if (wireId) transport.sessionEnd(wireId);
      await i.reply({ content: 'Voice-Channel verlassen.', flags: MessageFlags.Ephemeral });
    }

    if (i.commandName === 'save-session') {
      if (!sessions.active) return i.reply({ content: 'Keine aktive Session.', flags: MessageFlags.Ephemeral });
      const s = sessions.active;
      await i.reply({ content: 'Finalisiere Session … das kann je nach Länge etwas dauern.', flags: MessageFlags.Ephemeral });
      try {
        await mixSession(s.dir, 'session_mix.ogg', s.timeline);
        s.status = 'closed';
        sessions.persist();
        await i.followUp({ content: `Session gespeichert: ${path.join(s.dir, 'session_mix.ogg')}`, flags: MessageFlags.Ephemeral });
        transport.clearVoiceConnection();
        const wireId = sessions.wireSessionId();
        if (wireId) transport.sessionEnd(wireId);
        sessions.active = null;
      } catch (e) {
        error(e);
        await i.followUp({ content: 'Fehler beim Finalisieren (siehe Logs).', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (e) {
    error(e);
    try { await (i.deferred || i.replied ? i.followUp('Fehler.') : i.reply('Fehler.')); } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
