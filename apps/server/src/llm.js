import { readFileSync } from 'fs';
import { log, debug, warn } from './logger.js';
import { complete, warmUp } from './providers/llm.js';

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

// Parse the model's raw output. Returns { text, speakerId, model }.
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

// Preload the model (Ollama keep-alive; no-op for OpenAI-style providers).
export { warmUp };

// Answer a query. Returns { text, speakerId, model }.
// `history` is an array of { role, content } objects (mutable — caller manages it).
// `systemBlocks` are extra `system` messages (campaign context, rolling summary,
// live transcript) appended after the base system prompt — empty/blank entries
// are dropped so an unavailable block costs nothing. Backend: providers/llm.js
// (LLM_PROVIDER=ollama | openai).
export async function chat(history, query, { systemBlocks = [] } = {}) {
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

  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
  const { content } = await complete({ messages, timeoutMs });
  const result = parseResponse(content);
  log('llm: response=', JSON.stringify(result));
  return result;
}
