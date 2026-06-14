// Session briefing at /join (Phase 4 — feature/obsidian-session-start).
//
// When a session starts (or resumes), the rolling summary reconstructed from the
// JSONL is used as the search text for a RAG query against the Obsidian vault.
// The retrieved chunks are prepended to the session's conversationHistory as a
// `role: system` message so the answer LLM can pick up "where we left off"
// without the players having to recap. Optionally, a short human-readable
// briefing is posted to the Discord channel.
//
// Entirely best-effort: every failure (RAG down, Ollama down, no summary yet)
// degrades to a no-op so /join is never delayed or broken by it.

import { randomUUID } from 'crypto';
import { log, warn, debug } from './logger.js';
import { queryRag, ragEnabled } from './ragClient.js';
import { broadcastToAllBots } from './broadcast.js';

function briefingEnabled() {
  return (process.env.RAG_BRIEFING_ENABLED ?? 'true') !== 'false';
}

function briefingTopK() {
  const v = Number(process.env.RAG_BRIEFING_TOP_K ?? 3);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 3;
}

function wakeWordName() {
  return process.env.WAKE_WORD ?? 'Rabenauge';
}

const BRIEFING_SYSTEM = [
  'Du bist die Spielleiter-Assistenz einer Pen-and-Paper-Runde.',
  'Fasse in zwei bis drei kurzen deutschen Sätzen zusammen, wo die Gruppe',
  'zuletzt stand und woran sie anknüpfen kann. Nutze die Zusammenfassung der',
  'letzten Sitzung und den Vault-Kontext. Nenne Eigennamen exakt.',
  'Antworte NUR mit dem Briefing-Text, ohne Vorrede oder Formatierung.',
].join('\n');

// One plain-text Ollama call → a short "where we left off" briefing. Returns ''
// on any error (the caller treats that as "skip the Discord post").
async function generateBriefing(summary, context) {
  const base  = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL ?? 'llama3';
  const userContent = [
    `Zusammenfassung der letzten Sitzung:\n${summary}`,
    `Vault-Kontext:\n${context}`,
  ].join('\n\n');
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: BRIEFING_SYSTEM },
          { role: 'user',   content: userContent },
        ],
        stream: false,
      }),
    });
    if (!res.ok) { warn(`sessionBriefing: LLM HTTP ${res.status}`); return ''; }
    const data = await res.json();
    return (data.message?.content ?? '').trim();
  } catch (e) {
    warn('sessionBriefing: LLM call failed:', e.message);
    return '';
  }
}

// Build a /join briefing from the vault and inject it into the session context.
// No-op when RAG is unconfigured/disabled, there is no prior summary to search
// on, or the vault returns nothing. `channelId` is only needed for the optional
// Discord post.
export async function maybeSessionBriefing(session, sessionId, { channelId = null } = {}) {
  if (!ragEnabled() || !briefingEnabled()) return;
  const summary = session?.liveContext?.summary?.trim();
  if (!summary) {
    debug('sessionBriefing: no prior summary — skipping');
    return; // fresh campaign / nothing to anchor on
  }

  const context = await queryRag(summary, briefingTopK());
  if (!context) {
    debug('sessionBriefing: RAG returned nothing — skipping');
    return;
  }

  // Inject the factual vault context as a system message at the very front of
  // the conversation so the answer LLM has it from the first turn on.
  if (Array.isArray(session.conversationHistory)) {
    session.conversationHistory.unshift({
      role: 'system',
      content: `Kontext aus dem Vault zum Anknüpfen an die letzte Sitzung:\n${context}`,
    });
  }
  log(`sessionBriefing: injected ${context.length} chars of vault context sid=${sessionId}`);

  // Optional human-facing briefing in the Discord channel.
  if ((process.env.RAG_BRIEFING_POST_CHAT ?? 'false') === 'true' && channelId) {
    const text = await generateBriefing(summary, context);
    if (text) {
      broadcastToAllBots({
        type: 'chat_message',
        cmdId: randomUUID(),
        channelId,
        assistantName: wakeWordName(),
        briefing: text,
      });
      log('sessionBriefing: posted briefing to Discord');
    }
  }
}
