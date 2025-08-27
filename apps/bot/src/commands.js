import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID; // empfohlen: Guild-Scoped

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
    name: 'save-session',
    description: 'Finalisiert die aktuelle Session und mischt eine Session-Datei',
  },
];

async function main() {
  const rest = new REST({ version: '10' }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands((await rest.get(Routes.oauth2CurrentApplication())).id, guildId), { body: commands });
    console.log('Slash-Commands (Guild) registriert');
  } else {
    const app = await rest.get(Routes.oauth2CurrentApplication());
    await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log('Slash-Commands (global) registriert (Propagation kann dauern)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});