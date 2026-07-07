// Bot-seitiger Override-Layer (Gegenstück zu apps/server/src/configStore.js).
//
// Der Bot besitzt seine eigene Override-Datei (DATA_DIR/config.overrides.json),
// weil er ein eigener Prozess auf potenziell anderem Host ist — der Server kann
// nicht in sein Dateisystem schreiben. Der Server pusht Änderungen über den
// Control-Kanal (Nachricht `config_update`); dieses Modul wendet sie auf
// process.env an und persistiert sie.
//
// Boot-Reihenfolge: applyOverridesAtBoot() MUSS laufen, bevor Module wie
// session.js ihre ENV-Konstanten (DATA_DIR, SESSION_IDLE_HOURS) beim Import
// lesen — daher wird es aus bootConfig.js als sehr frühes Modul aufgerufen und
// importiert bewusst NICHT logger.js (dessen DEBUG-Konstante würde sonst vor
// dem Override eingefroren).

import fs from 'fs';
import path from 'path';

function log(...args) { console.log('[configOverrides]', ...args); }
function debug(...args) { if (process.env.DEBUG === '1') console.log('[configOverrides]', ...args); }

// Nur diese Keys darf der Bot aus einem config_update übernehmen (Defense-in-Depth;
// der Server validiert bereits gegen den Katalog). Spiegelt die bot-scope-Keys
// aus apps/server/src/configCatalog.js.
//
// CONTRACT: Eine neue Bot-Konfigurationsvariable wird IMMER auf beiden Seiten
// eingetragen — Katalog-Eintrag (scope 'bot') in apps/server/src/configCatalog.js
// für Doku/Validierung/UI UND hier in BOT_KEYS. Fehlt sie hier, ignoriert der
// Bot den Push; fehlt der Katalog-Eintrag, taucht sie nie im Settings-Panel auf.
const BOT_KEYS = new Set([
  'GUILD_IDS', 'GUILD_ID', 'DEBUG',
  'SERVER_BASE_URL', 'CONTROL_WS_URL', 'SERVER_START_CMD',
  'DATA_DIR', 'SESSION_IDLE_HOURS',
  'FINALIZE_UPLOAD_CMD', 'ARCHIVE_RETENTION',
  'GATE_MS', 'PLAYOUT_MAX_MS', 'INTERRUPT_MIN_MS', 'RESUME_GATE_MS', 'REWIND_MS',
]);

// Keys, die zusätzlich zum Report gehören, obwohl sie nicht pushbar sind
// (Secrets, per Blacklist erkannt): der Server zeigt für sie nur „gesetzt?" an.
const REPORT_ONLY_KEYS = ['DISCORD_TOKEN', 'CONTROL_BEARER'];

// Namens-Blacklist für Geheimnisse — Gegenstück zu SECRET_KEY_PATTERNS in
// apps/server/src/configCatalog.js. Werte solcher Keys verlassen den Bot nie;
// im config_state-Report steht nur, OB sie gesetzt sind.
const SECRET_KEY_PATTERNS = [
  /TOKEN/i, /SECRET/i, /BEARER/i, /PASSWORD/i, /(^|_)PASS(_|$)/i,
  /API_?KEY/i, /PRIVATE_?KEY/i, /CREDENTIAL/i,
];
function isSecretKey(key) {
  return SECRET_KEY_PATTERNS.some((re) => re.test(String(key || '')));
}

// Dateipfad einmal beim Boot fixieren — abgeleitet aus dem .env-DATA_DIR, damit
// ein DATA_DIR-Override die Override-Datei nicht „verschiebt".
let _file = null;
function file() {
  if (!_file) _file = path.resolve(process.env.DATA_DIR ?? './data', 'config.overrides.json');
  return _file;
}

// Baseline = process.env NACH .env/dotenv, VOR unseren Overrides (für Reset).
let _baseline = null;

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return (raw && typeof raw.bot === 'object' && raw.bot) ? raw.bot : {};
  } catch {
    return {};
  }
}

function write(bot) {
  const fp = file();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ version: 1, bot }, null, 2));
}

// Beim Bot-Start aufrufen: persistierte Overrides auf process.env legen.
export function applyOverridesAtBoot() {
  if (!_baseline) _baseline = { ...process.env };
  const bot = read();
  let n = 0;
  for (const [k, v] of Object.entries(bot)) {
    if (!BOT_KEYS.has(k)) continue;
    process.env[k] = String(v);
    n++;
  }
  if (n) log('applied', n, 'bot override(s) from', file());
  return n;
}

// Wendet ein `config_update` vom Server an. { set:{K:v}, reset:[K], persist:bool }.
// Gibt eine Zusammenfassung für den Ack zurück.
export function applyConfigUpdate({ set = {}, reset = [], persist = true } = {}) {
  if (!_baseline) _baseline = { ...process.env };
  const bot = read();
  const applied = [];
  const ignored = [];

  for (const [k, vRaw] of Object.entries(set)) {
    if (!BOT_KEYS.has(k)) { ignored.push(k); continue; }
    const v = String(vRaw);
    process.env[k] = v;
    if (persist) bot[k] = v;
    applied.push(k);
  }
  for (const k of reset) {
    if (!BOT_KEYS.has(k)) { ignored.push(k); continue; }
    if (_baseline && Object.prototype.hasOwnProperty.call(_baseline, k)) process.env[k] = _baseline[k];
    else delete process.env[k];
    if (persist) delete bot[k];
    applied.push(k);
  }

  if (persist && (Object.keys(set).length || reset.length)) write(bot);
  debug('applied config_update: set/reset', applied.join(','), 'persist=', persist,
    ignored.length ? `(ignoriert: ${ignored.join(',')})` : '');
  return { applied, ignored, persisted: persist };
}

// Ist-Zustand für den config_state-Report an den Server: die tatsächlichen
// process.env-Werte aller BOT_KEYS. Secrets (Blacklist) NIE als Wert — nur als
// „gesetzt?"-Boolean unter secretsSet, ebenso die reinen Report-Keys.
export function reportableConfig() {
  const values = {};
  const secretsSet = {};
  for (const k of BOT_KEYS) {
    const v = process.env[k];
    if (isSecretKey(k)) { secretsSet[k] = typeof v === 'string' && v.length > 0; continue; }
    if (v !== undefined) values[k] = String(v);
  }
  for (const k of REPORT_ONLY_KEYS) {
    const v = process.env[k];
    secretsSet[k] = typeof v === 'string' && v.length > 0;
  }
  return { values, secretsSet };
}
