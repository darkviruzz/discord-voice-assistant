import { debug } from './logger.js';
import { randomUUID } from 'crypto';

// Shared set of all connected+registered bot WebSocket connections.
// Populated by control.js; consumed by pipeline.js for fire-and-forget pushes.
export const botConnections = new Set();

// Returns the number of bots the message actually went out to.
export function broadcastToAllBots(msg) {
  if (!msg.cmdId) msg = { ...msg, cmdId: randomUUID() };
  let sent = 0;
  for (const ws of botConnections) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); sent++; } catch {}
    }
  }
  debug('broadcast:', msg.type, 'to', sent, 'bot(s)');
  return sent;
}
