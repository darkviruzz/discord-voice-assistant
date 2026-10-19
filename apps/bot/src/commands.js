import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

const token = process.env.DISCORD_TOKEN;
const raw = process.env.GUILD_IDS || process.env.GUILD_ID || '';
const guildIds = raw.split(',').map(s => s.trim()).filter(Boolean);

const commands = [
  {
    name: 'join',
    description: 'Bot joint deinen Voice-Channel und startet die Session',
  },
  {
    name: 'leave',
    description: 'Bot verlässt den Voice-Channel',
  },
  {
    name: 'finalize',
    description: 'Session abschließen: Transkript + Audio-Archiv erzeugen',
    options: [
      {
        name: 'run',
        description: 'Aktuelle (oder angegebene) Session finalisieren',
        type: 1, // SUB_COMMAND
        options: [
          { name: 'session', description: 'Session-ID (Standard: aktive Session)', type: 3, required: false },
        ],
      },
      {
        name: 'list',
        description: 'Sessions auflisten (offen/finalisiert)',
        type: 1,
      },
      {
        name: 'show',
        description: 'Details zu einer Session anzeigen',
        type: 1,
        options: [
          { name: 'session', description: 'Session-ID', type: 3, required: true },
        ],
      },
      {
        name: 'map',
        description: 'Sprecher-Zuordnung anzeigen/setzen (Discord-Nutzer → Spieler/Charakter)',
        type: 1, // SUB_COMMAND
        options: [
          { name: 'user', description: 'Discord-Nutzer (leer = alle anzeigen)', type: 6, required: false },
          { name: 'player', description: 'Spielername', type: 3, required: false },
          { name: 'character', description: 'Charaktername', type: 3, required: false },
          { name: 'phonetic', description: 'Phonetische Schreibweise (für TTS)', type: 3, required: false },
        ],
      },
    ],
  },
  {
    name: 'ask',
    description: 'Stellt Rabenauge eine Textfrage',
    options: [
      {
        name: 'frage',
        description: 'Deine Frage',
        type: 3,
        required: true,
      },
      {
        name: 'tts',
        description: 'Antwort zusätzlich im Voice-Channel vorlesen',
        type: 5,
        required: false,
      },
    ],
  },
  {
    name: 'recap',
    description: 'Rabenauge fasst zusammen, was in der letzten Sitzung passiert ist',
    options: [
      {
        name: 'tts',
        description: 'Zusammenfassung zusätzlich im Voice-Channel vorlesen',
        type: 5,
        required: false,
      },
    ],
  },
  {
    name: 'server',
    description: 'Server-Verbindung verwalten',
    options: [
      {
        name: 'restart',
        description: 'Server neu starten (per SSH) und verbinden',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'status',
        description: 'Verbindungs- und Versionsstatus anzeigen',
        type: 1, // SUB_COMMAND
      },
    ],
  },
];

async function main() {
  const rest = new REST({ version: '10' }).setToken(token);
  const app = await rest.get(Routes.oauth2CurrentApplication());
  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(app.id, guildId), { body: commands });
      console.log(`Slash-Commands registriert für Guild: ${guildId}`);
    }
  } else {
    await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log('Slash-Commands (global) registriert (Propagation kann dauern)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
