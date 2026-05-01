import { log } from './logger.js';

const DEFAULT_SYSTEM = 'Du bist Rabenauge, ein hilfreicher Assistent für eine Pen-and-Paper-Runde. Antworte kurz und prägnant auf Deutsch.';

// Send a query to Ollama and return the response text.
// `history` is an array of { role, content } objects (mutable — caller manages it).
export async function chat(history, query) {
  const base    = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const model   = process.env.OLLAMA_MODEL ?? 'llama3';
  const system  = process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM;
  const maxTurns = Number(process.env.HISTORY_TURNS ?? 6);

  // Keep at most maxTurns × 2 messages (user + assistant pairs).
  const recentHistory = history.slice(-(maxTurns * 2));

  const messages = [
    { role: 'system', content: system },
    ...recentHistory,
    { role: 'user',   content: query },
  ];

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages, stream: false }),
    });
  } catch (e) {
    throw new Error(`llm: connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`llm: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.message?.content ?? '').trim();
  log('llm: response=', JSON.stringify(text));
  return text;
}
