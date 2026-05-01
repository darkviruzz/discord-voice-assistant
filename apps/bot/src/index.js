import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { Client, GatewayIntentBits, Partials, MessageFlags } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { log, warn, error, debug } from './logger.js';
import { SessionManager } from './session.js';
import { UtteranceRecorder } from './recorder.js';
import { mixSession } from './mixer.js';
import * as transport from './transport/index.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel]
});

const sessions = new SessionManager();
const activeRecordings = new Map();

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

// Creates a fresh voice connection, wires up the receiver and state handlers.
// On a Connecting→Signalling redirect (Discord voice server migration mid-handshake),
// we destroy the current connection fully (removing it from @discordjs/voice's guild
// registry) and wait 1 s before creating a new one. The destroy+delay forces
// @discordjs/voice to send a fresh OP 4 VOICE_STATE_UPDATE, which Discord needs
// before it will respond with the VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE pair
// required to reach Ready.
function connectToVoiceChannel(channel, attempt = 0) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  connection.on('stateChange', (oldState, newState) => {
    debug('voice:', oldState.status, '->', newState.status);

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      warn('voice: disconnected code=', newState.closeCode ?? '(none)');
    }

    if (oldState.status === VoiceConnectionStatus.Connecting &&
        newState.status === VoiceConnectionStatus.Signalling) {
      if (attempt < 3) {
        debug('voice: server redirect — destroying and recreating (attempt', attempt + 1, ')');
        connection.destroy();
        setTimeout(() => {
          const newConn = connectToVoiceChannel(channel, attempt + 1);
          transport.setVoiceConnection(newConn);
        }, 1000);
      } else {
        warn('voice: too many redirects, giving up');
      }
    }

    if (newState.status === VoiceConnectionStatus.Ready) {
      debug('voice: ready — receiver active');
    }
  });

  connection.on('error', (e) => warn('voice: connection error:', e.message));

  const receiver = connection.receiver;

  receiver.speaking.on('start', (userId) => {
    debug('speaking: start userId=', userId);
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
    transport.speakingEnd(userId);
  });

  return connection;
}

client.once('clientReady', async () => {
  log(`Bot online als ${client.user.tag}`);
  await recoverOldSessions();
  transport.start({ botId: client.user.id });
});

client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'join') {
      const member = await i.guild.members.fetch(i.user.id);
      const channel = member.voice.channel;
      if (!channel) return i.reply({ content: 'Du bist in keinem Voice-Channel.', flags: MessageFlags.Ephemeral });

      sessions.loadOrStartNew();
      transport.sessionStart({
        sessionId: sessions.wireSessionId(),
        guildId: channel.guild.id,
        channelId: channel.id,
        startedAt: sessions.active.startedAt,
      });

      const connection = connectToVoiceChannel(channel);
      transport.setVoiceConnection(connection);

      await i.reply({ content: `Verbunden mit **${channel.name}**. Aufnahme läuft (Session ${sessions.wireSessionId()}).`, flags: MessageFlags.Ephemeral });
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
