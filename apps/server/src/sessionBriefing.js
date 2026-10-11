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
//
// Runs at most once per session object: the bot re-emits session_start after
// every control reconnect and on /leave → /join resume, and each of those must
// neither stack another system message nor re-post to Discord.

import { randomUUID } from 'crypto';
import { log, warn, debug } from './logger.js';
import { complete } from './providers/llm.js';
import { queryRag, ragEnabled, ragConfig, formatRagHits } from './rag/index.js';
import { capCampaignContext } from './campaignContext.js';
import { broadcastToAllBots } from './broadcast.js';
import { sessions } from './state.js';

// The briefing is fire-and-forget (never on the voice hot path) and runs right
// at /join, when the embedding model is often still cold in Ollama — so it gets
// at least this much time instead of the tight per-query RAG_TIMEOUT_MS.
const BRIEFING_MIN_TIMEOUT_MS = 5000;

function briefingEnabled() {
  return (process.env.RAG_BRIEFING_ENABLED ?? 'true') !== 'false';
}

function briefingTopK() {
  const v = Number(process.env.RAG_BRIEFING_TOP_K ?? 3);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 3;
}

function briefingPostChat() {
  return (process.env.RAG_BRIEFING_POST_CHAT ?? 'false') === 'true';
}

// Effective briefing settings (session_meta report).
export function briefingConfig() {
  return {
    briefingEnabled: briefingEnabled(),
    briefingTopK: briefingTopK(),
    briefingPostChat: briefingPostChat(),
  };
}

// The session may have ended (session_end / finalize → dropSession) while RAG
// or the LLM was still answering; a dropped session gets no injection or post.
function stillLive(session, sessionId) {
  try { return sessions.get(BigInt(sessionId)) === session; } catch { return false; }
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

// One plain-text LLM call → a short "where we left off" briefing. Returns ''
// on any error (the caller treats that as "skip the Discord post").
async function generateBriefing(summary, context) {
  const userContent = [
    `Zusammenfassung der letzten Sitzung:\n${summary}`,
    `Vault-Kontext:\n${context}`,
  ].join('\n\n');
  try {
    const { content } = await complete({
      messages: [
        { role: 'system', content: BRIEFING_SYSTEM },
        { role: 'user',   content: userContent },
      ],
      timeoutMs: 120_000,
    });
    return content;
  } catch (e) {
    warn('sessionBriefing: LLM call failed:', e.message);
    return '';
  }
}

// Build a /join briefing from the vault and inject it into the session context.
// No-op when RAG is unconfigured/disabled, there is no prior summary to search
// on, or the vault returns nothing. `channelId` is only needed for the optional
// Discord post. `after` is the live-context rebuild that fills the summary; the
// once-per-session claim happens synchronously at call time (before awaiting
// it), so a reconnect's session_start racing the first rebuild can neither run
// a second briefing nor consume the first one with a still-empty summary.
export async function maybeSessionBriefing(session, sessionId, { channelId = null, after = null } = {}) {
  if (!session || session.briefingAttempted) return;
  session.briefingAttempted = true;
  if (after) {
    try { await after; } catch { return; } // rebuild failed — logged by its caller
  }

  if (!ragEnabled() || !briefingEnabled()) return;
  const summary = session.liveContext?.summary?.trim();
  if (!summary) {
    debug('sessionBriefing: no prior summary — skipping');
    return; // fresh campaign / nothing to anchor on
  }

  const timeoutMs = Math.max(ragConfig().timeoutMs, BRIEFING_MIN_TIMEOUT_MS);
  const context = capCampaignContext(formatRagHits(await queryRag(summary, { topK: briefingTopK(), timeoutMs })));
  if (!context) {
    debug('sessionBriefing: RAG returned nothing — skipping');
    return;
  }
  if (!stillLive(session, sessionId)) {
    debug('sessionBriefing: session ended meanwhile — skipping');
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
  if (briefingPostChat() && channelId) {
    const text = await generateBriefing(summary, context);
    if (text && stillLive(session, sessionId)) {
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
