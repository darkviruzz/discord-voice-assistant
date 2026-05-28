import fs from 'fs';
import path from 'path';
import { warn } from './logger.js';

// Persistent per-guild speaker mapping: Discord userId → { player, character,
// phonetic }. Stored as { [guildId]: { [userId]: {...} } } in a JSON file.
// M3 wires the interactive mapping commands; this is the shared store.
function mapFile() {
  return process.env.SPEAKER_MAP_FILE ?? path.resolve(process.env.DATA_DIR ?? './data', 'speaker-map.json');
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(all) {
  const fp = mapFile();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(all, null, 2));
}

// Mapping for one guild ({} when none). Pass null/undefined to get an empty map.
export function loadSpeakerMap(guildId) {
  if (guildId == null) return {};
  const all = readAll();
  return all[String(guildId)] || {};
}

// Upsert one user's mapping within a guild. entry = { player?, character?, phonetic? }.
export function setSpeakerMapping(guildId, userId, entry) {
  if (guildId == null || userId == null) return;
  const all = readAll();
  const g = (all[String(guildId)] ||= {});
  g[String(userId)] = { ...(g[String(userId)] || {}), ...entry };
  writeAll(all);
  return g[String(userId)];
}

export function removeSpeakerMapping(guildId, userId) {
  const all = readAll();
  const g = all[String(guildId)];
  if (g && g[String(userId)]) { delete g[String(userId)]; writeAll(all); return true; }
  return false;
}
