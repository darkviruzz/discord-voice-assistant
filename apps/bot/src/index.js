import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, VoiceReceiver } from '@discordjs/voice';
import { log, warn, error, debug } from './logger.js';
import { SessionManager } from './session.js';
import { UtteranceRecorder } from './recorder.js';
import { mixSession } from './mixer.js';

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

client.once('ready', async () => {
  log(`Bot online als ${client.user.tag}`);
  await recoverOldSessions();
});

client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === 'join') {
      const member = await i.guild.members.fetch(i.user.id);
      const channel = member.voice.channel;
      if (!channel) return i.reply({ content: 'Du bist in keinem Voice-Channel.', ephemeral: true });

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true, // wir hören nicht zu
      });

      sessions.loadOrStartNew();

      // Receiver aufsetzen
      const receiver = connection.receiver; // VoiceReceiver

      // speaking events liefern die Benutzer, die sprechen
      receiver.speaking.on('start', (userId) => {
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

      await i.reply({ content: `Verbunden mit **${channel.name}**. Aufnahme läuft (Session ${sessions.active.id}).`, ephemeral: true });
    }

    if (i.commandName === 'leave') {
      const conn = getVoiceConnection(i.guildId);
      if (conn) conn.destroy();
      await i.reply({ content: 'Voice-Channel verlassen.', ephemeral: true });
    }

    if (i.commandName === 'save-session') {
      if (!sessions.active) return i.reply({ content: 'Keine aktive Session.', ephemeral: true });
      const s = sessions.active;
      await i.reply({ content: 'Finalisiere Session … das kann je nach Länge etwas dauern.', ephemeral: true });
      try {
        await mixSession(s.dir, 'session_mix.ogg', s.timeline);
        s.status = 'closed';
        sessions.persist();
        await i.followUp({ content: `Session gespeichert: ${path.join(s.dir, 'session_mix.ogg')}`, ephemeral: true });
        sessions.active = null;
      } catch (e) {
        error(e);
        await i.followUp({ content: 'Fehler beim Finalisieren (siehe Logs).', ephemeral: true });
      }
    }
  } catch (e) {
    error(e);
    try { await (i.deferred || i.replied ? i.followUp('Fehler.') : i.reply('Fehler.')); } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);