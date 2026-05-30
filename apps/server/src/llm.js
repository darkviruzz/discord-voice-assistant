import { readFileSync } from 'fs';
import { log, debug, warn } from './logger.js';

// Speaker IDs for de_DE-thorsten_emotional-medium.onnx
// 0=Fröhlich 1=Wütend 2=Angewidert 3=Betrunken
// 4=Neutral  5=Schläfrig 6=Überrascht 7=Flüsternd
const DEFAULT_SYSTEM = [
  'Du bist Rabenauge, ein Assistent für eine Pen-and-Paper-Runde.',
  'Deine Antworten werden direkt vorgelesen.',
  '',
  'Antworte IMMER als JSON-Objekt mit exakt diesen Feldern:',
  '  "text"      : deine gesprochene Antwort (Pflicht)',
  '  "speaker_id": Zahl 0-7 passend zur Stimmung (Standard: 4)',
  '                0=Fröhlich 1=Wütend 2=Angewidert 3=Betrunken',
  '                4=Neutral  5=Schläfrig 6=Überrascht 7=Flüsternd',
  '  "model"     : "emotional" (Standard) oder "high" für sachliche Fakten',
  '',
  'Regeln für "text":',
  '- Kein Markdown, keine Tabellen, keine Aufzählungszeichen.',
  '- Vollständige, natürliche Sätze. Mindestens 3 Wörter.',
  '- Keine leeren Einstiegsfloskeln ("Natürlich!", "Gerne!", "Sicher!").',
  '- Immer auf Deutsch.',
  '',
  'Beispiel: {"text":"Baron Kelthur herrschte mit eiserner Faust.","speaker_id":4,"model":"high"}',
].join('\n');

// Load system prompt once at startup.
// Priority: SYSTEM_PROMPT_FILE (path to text file) > SYSTEM_PROMPT (inline) > DEFAULT_SYSTEM
const LOADED_SYSTEM = (() => {
  const file = process.env.SYSTEM_PROMPT_FILE;
  if (file) {
    try { return readFileSync(file, 'utf8').trim(); }
    catch (e) { console.error(`llm: cannot read SYSTEM_PROMPT_FILE "${file}":`, e.message); }
  }
  return process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM;
})();

// Parse Ollama's raw output. Returns { text, speakerId, model }.
// Handles: plain JSON, JSON inside markdown fences, plain text fallback.
function parseResponse(raw) {
  const stripped = raw.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/,  '');
  try {
    const obj = JSON.parse(stripped);
    if (typeof obj.text === 'string' && obj.text.trim()) {
      return {
        text:      obj.text.trim(),
        speakerId: Number.isInteger(obj.speaker_id)
          ? Math.max(0, Math.min(7, obj.speaker_id)) : 4,
        model:     obj.model === 'high' ? 'high' : 'emotional',
      };
    }
  } catch {}
  // Plain-text fallback — neutral emotional voice.
  debug('llm: response was not JSON, using plain text fallback');
  return { text: raw.trim(), speakerId: 4, model: 'emotional' };
}

// How long Ollama keeps the model resident in VRAM after a request. Set on
// every chat call (and the warm-up) so the model isn't unloaded between
// queries during an active session. Default 30m; "-1" keeps it loaded forever.
function keepAlive() {
  return process.env.OLLAMA_KEEP_ALIVE ?? '30m';
}

// Preload / keep the configured model resident in VRAM. Ollama loads the model
// on an empty-messages /api/chat request, and `keep_alive` resets its idle
// unload timer. Best-effort: never throws — keep-warm is an optimization, not a
// correctness requirement. Returns true on success.
export async function warmUp() {
  const base  = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const model  = process.env.OLLAMA_MODEL ?? 'llama3';
  try {
    const res = await fetch(`${base}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages: [], keep_alive: keepAlive(), stream: false }),
    });
    if (!res.ok) {
      warn(`llm: warm-up HTTP ${res.status}`);
      return false;
    }
    await res.json().catch(() => null);
    debug(`llm: warm-up ok (model=${model}, keep_alive=${keepAlive()})`);
    return true;
  } catch (e) {
    warn(`llm: warm-up failed: ${e.message}`);
    return false;
  }
}

// Send a query to Ollama. Returns { text, speakerId, model }.
// `history` is an array of { role, content } objects (mutable — caller manages it).
// `systemBlocks` are extra `system` messages (campaign context, rolling summary,
// live transcript) appended after the base system prompt — empty/blank entries
// are dropped so an unavailable block costs nothing.
export async function chat(history, query, { systemBlocks = [] } = {}) {
  const base     = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const model    = process.env.OLLAMA_MODEL ?? 'llama3';
  const system   = LOADED_SYSTEM;
  const maxTurns = Number(process.env.HISTORY_TURNS ?? 6);

  const recentHistory = history.slice(-(maxTurns * 2));
  const extraBlocks = (Array.isArray(systemBlocks) ? systemBlocks : [])
    .filter((b) => typeof b === 'string' && b.trim())
    .map((b) => ({ role: 'system', content: b }));
  const messages = [
    { role: 'system', content: system },
    ...extraBlocks,
    ...recentHistory,
    { role: 'user',   content: query },
  ];
  if (extraBlocks.length) {
    debug(`llm: ${extraBlocks.length} extra system block(s), ${extraBlocks.reduce((n, b) => n + b.content.length, 0)} chars`);
  }

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages, keep_alive: keepAlive(), stream: false }),
    });
  } catch (e) {
    throw new Error(`llm: connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`llm: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data   = await res.json();
  const raw    = (data.message?.content ?? '').trim();
  const result = parseResponse(raw);
  log('llm: response=', JSON.stringify(result));
  return result;
}
