// ============================================================================
// Override-Layer (Variante B) — persistente Konfigurations-Overrides für den
// Server, plus die vom Panel verwaltete Desired-State-Kopie der Bot-Overrides.
//
// Schichtung:  .env (Defaults)  →  Overrides-Datei  →  temporäre Overrides
//
//   1. dotenv lädt .env in process.env (Baseline).
//   2. applyServerOverrides() schreibt beim Boot die persistierten server-Overrides
//      obendrauf — VOR dem Import der Module, die ihre Konstanten beim Laden lesen.
//   3. Zur Laufzeit kann das Panel Werte setzen: persistent (in die Datei) oder
//      temporär (nur in-memory / process.env, geht beim Neustart verloren).
//
// Dateiformat (./data/config.overrides.json):
//   { "version": 1, "server": { KEY: "wert" }, "bot": { KEY: "wert" } }
//
// Der "server"-Abschnitt gilt für diesen Prozess. Der "bot"-Abschnitt ist die
// vom UI verwaltete Wunsch-Konfiguration, die über den Control-Kanal an
// verbundene Bots gepusht wird (der Bot persistiert sie zusätzlich lokal).
// ============================================================================

import fs from 'fs';
import path from 'path';
import { catalogEntry } from './configCatalog.js';

// Kein Import von logger.js: dieses Modul läuft im Boot-Pfad, BEVOR logger.js
// (und dessen DEBUG-Konstante) importiert wird. Ein eigener, abhängigkeitsfreier
// Debug-Logger, der DEBUG live liest.
function debug(...args) { if (process.env.DEBUG === '1') console.log('[configStore]', ...args); }

function overridesFile() {
  return process.env.CONFIG_OVERRIDES_FILE
    ?? path.resolve(process.env.DATA_DIR ?? './data', 'config.overrides.json');
}

// Baseline = Zustand von process.env NACH dotenv, aber VOR unseren Overrides.
// Erlaubt „Zurücksetzen" auf den .env-/Default-Wert. Wird einmalig gefüllt.
let _baseline = null;

// Keys, die zur Laufzeit nur temporär (nicht in der Datei) gesetzt wurden.
// Server: Set von Keys. Bot: Map key→value (der Server kennt den Bot-Zustand
// nicht direkt, merkt sich aber, was er zuletzt temporär gepusht hat).
const _tempServer = new Set();
const _tempBot = new Map();

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(overridesFile(), 'utf8'));
    return {
      version: 1,
      server: (raw && typeof raw.server === 'object' && raw.server) || {},
      bot: (raw && typeof raw.bot === 'object' && raw.bot) || {},
    };
  } catch {
    return { version: 1, server: {}, bot: {} };
  }
}

function writeFile(obj) {
  const fp = overridesFile();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ version: 1, server: obj.server, bot: obj.bot }, null, 2));
}

// Beim Boot aufrufen (aus bootConfig.js), nachdem dotenv geladen hat.
export function applyServerOverrides() {
  if (!_baseline) _baseline = { ...process.env };
  const { server } = readFile();
  let n = 0;
  for (const [k, v] of Object.entries(server)) {
    process.env[k] = String(v);
    n++;
  }
  if (n) debug('configStore: applied', n, 'server override(s) from', overridesFile());
  return n;
}

export function getOverrides() { return readFile(); }
export function getBotOverrides() { return readFile().bot; }

// Effektiver aktueller Wert einer Variable (nach allen Schichten).
export function currentValue(key) {
  return process.env[key];
}

// Anzeige-Wert für das UI. Server-Vars stehen in process.env dieses Prozesses;
// Bot-Vars liest der Server-Prozess NICHT — hier gilt der vom Panel verwaltete
// Desired State (temporär oder aus der Override-Datei) als beste Anzeige.
export function displayValue(scope, key) {
  if (scope === 'server') return process.env[key];
  if (_tempBot.has(key)) return _tempBot.get(key);
  const { bot } = readFile();
  return Object.prototype.hasOwnProperty.call(bot, key) ? bot[key] : undefined;
}

// Persistenz-Status eines Keys für die UI-Anzeige.
//   'temporary' — gesetzt, aber nicht in der Datei (geht bei Neustart verloren)
//   'persisted' — in der Overrides-Datei
//   'default'   — unverändert (aus .env bzw. Code-Default)
export function statusOf(scope, key) {
  const file = readFile();
  if (scope === 'server') {
    if (_tempServer.has(key)) return 'temporary';
    if (Object.prototype.hasOwnProperty.call(file.server, key)) return 'persisted';
    return 'default';
  }
  if (_tempBot.has(key)) return 'temporary';
  if (Object.prototype.hasOwnProperty.call(file.bot, key)) return 'persisted';
  return 'default';
}

// Setzt einen Server-Wert. persist=true → in Datei; persist=false → nur process.env.
export function setServerValue(key, value, persist) {
  if (!_baseline) _baseline = { ...process.env };
  process.env[key] = String(value);
  const file = readFile();
  if (persist) {
    file.server[key] = String(value);
    _tempServer.delete(key);
    writeFile(file);
  } else {
    // Temporär: falls zuvor persistiert, Datei-Eintrag entfernen wäre destruktiv —
    // wir lassen die Datei unangetastet und markieren nur den Laufzeit-Override.
    _tempServer.add(key);
  }
}

// Merkt sich einen Bot-Wert (Desired State). persist=true → in Datei.
// Das eigentliche Anwenden passiert im Bot; hier nur Persistenz + Status.
export function setBotValue(key, value, persist) {
  const file = readFile();
  if (persist) {
    file.bot[key] = String(value);
    _tempBot.delete(key);
    writeFile(file);
  } else {
    _tempBot.set(key, String(value));
  }
}

// Setzt einen Override zurück auf den .env-/Default-Wert (entfernt Persistenz).
export function resetValue(scope, key) {
  const file = readFile();
  if (scope === 'server') {
    delete file.server[key];
    _tempServer.delete(key);
    writeFile(file);
    if (_baseline && Object.prototype.hasOwnProperty.call(_baseline, key)) {
      process.env[key] = _baseline[key];
    } else {
      delete process.env[key];
    }
  } else {
    delete file.bot[key];
    _tempBot.delete(key);
    writeFile(file);
  }
}

// Koerziert + validiert einen eingehenden Wert gemäß Katalog. Wirft bei Fehler.
// Gibt die kanonische String-Repräsentation für process.env zurück.
export function coerce(scope, key, rawValue) {
  const entry = catalogEntry(scope, key);
  if (!entry) throw new Error(`unbekannte Variable ${scope}:${key}`);
  if (entry.editable === false) throw new Error(`${key} ist nicht editierbar`);
  if (entry.secret) throw new Error(`${key} ist ein Secret und kann hier nicht gesetzt werden`);

  const t = entry.type;
  if (t === 'boolean') {
    const on = entry.onValue ?? 'true';
    const off = entry.offValue ?? 'false';
    if (rawValue === true || rawValue === on || rawValue === 'true' || rawValue === '1') return on;
    if (rawValue === false || rawValue === off || rawValue === 'false' || rawValue === '0') return off;
    throw new Error(`${key} erwartet einen Boolean`);
  }
  if (t === 'number') {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) throw new Error(`${key} erwartet eine Zahl`);
    return String(n);
  }
  if (t === 'enum') {
    const s = String(rawValue);
    if (!entry.enumValues.includes(s)) {
      throw new Error(`${key} erwartet einen von: ${entry.enumValues.join(', ')}`);
    }
    return s;
  }
  if (t === 'list') {
    // Normalisiert eine kommagetrennte Liste (trim, leere raus).
    const parts = String(rawValue).split(',').map((p) => p.trim()).filter(Boolean);
    return parts.join(',');
  }
  // string
  return String(rawValue);
}

export { overridesFile };
