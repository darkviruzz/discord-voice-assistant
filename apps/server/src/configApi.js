// HTTP-API für das Settings-Panel.
//
//   GET  /transcript/config   → Katalog + aktuelle Werte + Persistenz-Status
//   PUT  /transcript/config   → Werte setzen/zurücksetzen (persistent oder temporär)
//
// Liegt unter /transcript und teilt sich damit die Basic-Auth der Transkript-UI
// (registerTranscriptRoutes mountet `app.use('/transcript', auth)` zuerst).
//
// Server-Variablen wirken direkt auf process.env dieses Prozesses. Bot-Variablen
// werden über den Control-Kanal an verbundene Bots gepusht (broadcastToAllBots)
// und dort persistiert; ist kein Bot verbunden, greifen sie beim nächsten Connect
// (der Server sendet dann seinen Desired State, siehe control.js).

import { debug, warn } from './logger.js';
import { CATALOG, APPLY_MODES, SCOPES, catalogEntry, isSecretEntry } from './configCatalog.js';
import {
  displayValue, statusOf, setServerValue, setBotValue, resetValue,
  coerce, overridesFile, getBotOverrides, getBotReported,
} from './configStore.js';
import { botConnections, broadcastToAllBots } from './broadcast.js';

// Baut die Item-Repräsentation einer Variable für das UI.
function itemFor(entry) {
  // Secret = Katalog-Flag ODER Namens-Blacklist (isSecretEntry). Ein Key, der
  // nur über die Blacklist als Secret erkannt wird, ist damit genauso
  // read-only und wert-los im Draht wie ein explizit geflaggter.
  const secret = isSecretEntry(entry);
  const editable = entry.editable !== false && !secret;
  const raw = displayValue(entry.scope, entry.key);
  const out = {
    scope: entry.scope,
    key: entry.key,
    label: entry.label,
    desc: entry.desc,
    type: entry.type,
    applyMode: entry.applyMode,
    secret,
    editable,
    def: entry.def ?? '',
    note: entry.note ?? null,
    status: statusOf(entry.scope, entry.key),
  };
  if (entry.enumValues) out.enumValues = entry.enumValues;
  if (entry.type === 'boolean') { out.onValue = entry.onValue ?? 'true'; out.offValue = entry.offValue ?? 'false'; }

  const reported = entry.scope === 'bot' ? getBotReported() : null;
  if (secret) {
    // Secrets: Wert nie ausliefern, nur ob gesetzt. Für Bot-Secrets kommt
    // „gesetzt?" aus dem config_state-Report des Bots (null = kein Report).
    out.value = null;
    if (entry.scope === 'server') {
      out.isSet = typeof raw === 'string' && raw.length > 0;
    } else {
      const s = reported?.secretsSet;
      out.isSet = s && Object.prototype.hasOwnProperty.call(s, entry.key) ? !!s[entry.key] : null;
    }
  } else if (entry.scope === 'bot' && reported?.values
    && Object.prototype.hasOwnProperty.call(reported.values, entry.key)) {
    // Ist-Wert, den der Bot zuletzt gemeldet hat — die Wahrheit für die Anzeige.
    // Weicht der Desired State (Override-Datei/temporär) davon ab, zeigt das UI
    // den Drift an (z. B. Änderung mit applyMode reconnect/restart noch nicht aktiv).
    out.value = reported.values[entry.key];
    out.botReported = true;
    const desired = raw;
    if (desired !== undefined && String(desired) !== String(reported.values[entry.key])) {
      out.desired = String(desired);
    }
  } else {
    out.value = raw ?? entry.def ?? '';
    if (entry.scope === 'bot') out.botReported = false;
  }
  return out;
}

function handleGet(_req, res) {
  // Gruppen in Katalog-Reihenfolge (Erst-Vorkommen).
  const groupOrder = [];
  const byGroup = new Map();
  for (const entry of CATALOG) {
    if (!byGroup.has(entry.group)) { byGroup.set(entry.group, []); groupOrder.push(entry.group); }
    byGroup.get(entry.group).push(itemFor(entry));
  }
  const groups = groupOrder.map((name) => ({
    name,
    scope: byGroup.get(name)[0].scope,
    items: byGroup.get(name),
  }));
  const reported = getBotReported();
  res.json({
    scopes: SCOPES,
    applyModes: APPLY_MODES,
    overridesFile: overridesFile(),
    botConnected: botConnections.size,
    botDesiredState: getBotOverrides(),
    // Letzter config_state-Report eines Bots (null = noch keiner empfangen).
    botReportedAt: reported?.at ?? null,
    groups,
  });
}

function handlePut(req, res) {
  const body = req.body || {};
  const persist = body.persist !== false; // default: dauerhaft speichern
  const updates = Array.isArray(body.updates) ? body.updates : [];
  const resets = Array.isArray(body.resets) ? body.resets : [];

  const applied = [];
  const warnings = [];
  const errors = [];
  const botSet = {};
  const botReset = [];

  for (const u of updates) {
    const scope = u.scope === 'bot' ? 'bot' : 'server';
    const key = String(u.key || '');
    const entry = catalogEntry(scope, key);
    if (!entry) { errors.push(`unbekannt: ${scope}:${key}`); continue; }
    let value;
    try { value = coerce(scope, key, u.value); }
    catch (e) { errors.push(e.message); continue; }

    if (!persist && entry.applyMode === 'restart') {
      warnings.push(`${key}: applyMode „Neustart nötig" — temporär ohne Wirkung, `
        + 'bitte dauerhaft speichern und Prozess neu starten.');
    }

    if (scope === 'server') {
      setServerValue(key, value, persist);
    } else {
      setBotValue(key, value, persist);
      botSet[key] = value;
    }
    applied.push({ scope, key, value, applyMode: entry.applyMode, persisted: persist });
  }

  for (const r of resets) {
    const scope = r.scope === 'bot' ? 'bot' : 'server';
    const key = String(r.key || '');
    const entry = catalogEntry(scope, key);
    if (!entry) { errors.push(`unbekannt: ${scope}:${key}`); continue; }
    resetValue(scope, key);
    if (scope === 'bot') botReset.push(key);
    applied.push({ scope, key, reset: true, applyMode: entry.applyMode });
  }

  // Bot-Änderungen über den Control-Kanal an verbundene Bots pushen.
  const hasBotChanges = Object.keys(botSet).length > 0 || botReset.length > 0;
  if (hasBotChanges) {
    broadcastToAllBots({
      type: 'config_update',
      persist,
      set: botSet,
      reset: botReset,
    });
    if (botConnections.size === 0) {
      warnings.push('Kein Bot verbunden — Bot-Änderungen wurden gespeichert und werden '
        + 'beim nächsten Bot-Connect angewendet.');
    }
  }

  if (errors.length) warn('config PUT errors:', errors.join('; '));
  else debug('config PUT applied', applied.length, 'change(s), persist=', persist);

  res.status(errors.length && !applied.length ? 400 : 200).json({
    ok: errors.length === 0,
    applied,
    warnings,
    errors,
    botConnected: botConnections.size,
    botPushed: hasBotChanges ? botConnections.size : 0,
  });
}

export function registerConfigRoutes(app) {
  // Auth wird bereits von registerTranscriptRoutes über app.use('/transcript', auth)
  // gestellt (muss VOR diesem Aufruf registriert sein).
  app.get('/transcript/config', handleGet);
  app.put('/transcript/config', handlePut);
}
