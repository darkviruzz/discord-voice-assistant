import './bootConfig.js'; // MUSS zuerst stehen: dotenv + Override-Layer vor allen anderen Imports
import http from 'http';
import express from 'express';
import { URL } from 'url';
import { log, warn, debug } from './logger.js';
import { initUplinkWSS } from './uplink.js';
import { initDownlinkWSS } from './downlink.js';
import { initControlWSS } from './control.js';
import { checkBearer, isLoopback } from './auth.js';
import { getVersion } from './version.js';
import { registerDebugTtsRoute } from './debugTts.js';
import { registerFinalizeHttpRoutes } from './finalizeHttp.js';
import { registerTranscriptRoutes } from './transcriptApi.js';
import { registerConfigRoutes } from './configApi.js';
import { startRag, stopRag } from './rag/index.js';

const HB_INTERVAL_MS = 15000;

const app = express();
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));
registerDebugTtsRoute(app);
registerFinalizeHttpRoutes(app); // PUT /finalize/upload/:sessionId/:filename — bot streams session WAVs (bearer from CONTROL_BEARER)
registerTranscriptRoutes(app); // mountet u.a. app.use('/transcript', auth) — vor den Config-Routen
registerConfigRoutes(app);     // /transcript/config (GET/PUT), teilt sich die Transkript-Auth
const bearer = process.env.CONTROL_BEARER;
if (!bearer) {
  warn('CONTROL_BEARER ist NICHT gesetzt — /control, /uplink, /downlink und /finalize/* sind '
    + 'ohne Authentifizierung erreichbar. Für jeden Betrieb außerhalb eines isolierten LANs setzen '
    + '(gleicher Wert in apps/bot/.env).');
}

// Unauthenticated shutdown was reachable by anyone who could reach the port.
// Allowed now from the machine itself (the launcher scripts) or with the bearer.
app.post('/shutdown', (req, res) => {
  if (!isLoopback(req) && !(bearer && checkBearer(req, bearer))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ status: 'shutting down' });
  setTimeout(() => shutdown('HTTP /shutdown'), 200);
});

const server = http.createServer(app);

const wssUplink   = initUplinkWSS(  { bearer });
const wssDownlink = initDownlinkWSS({});
const wssControl  = initControlWSS( { bearer });

// Single upgrade dispatcher: routes by URL path. Multiple WebSocketServer
// instances cannot share the same http server in `server: ...` mode without
// fighting over the upgrade event — first to fire path-rejects with 400.
// Using noServer: true and dispatching here avoids that.
const ROUTES = {
  '/uplink':   { wss: wssUplink,   requireBearer: true  },
  // The bot's DownlinkClient sends the same bearer header as uplink/control —
  // without the check anyone reaching the port could subscribe to TTS audio.
  '/downlink': { wss: wssDownlink, requireBearer: true  },
  '/control':  { wss: wssControl,  requireBearer: true  },
};

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch { socket.destroy(); return; }

  const route = ROUTES[pathname];
  if (!route) {
    debug('upgrade: unknown path', pathname);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (route.requireBearer && !checkBearer(req, bearer)) {
    debug('upgrade: auth rejected for', pathname);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  route.wss.handleUpgrade(req, socket, head, (ws) => route.wss.emit('connection', ws, req));
});

// Heartbeat across all WSS clients.
const allWss = [wssUplink, wssDownlink, wssControl];
const hbTimer = setInterval(() => {
  for (const wss of allWss) {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }
}, HB_INTERVAL_MS);
hbTimer.unref?.();

function shutdown(reason) {
  log('shutdown:', reason);
  clearInterval(hbTimer);
  for (const wss of allWss) {
    for (const ws of wss.clients) {
      try { ws.close(4010, 'SERVER_SHUTDOWN'); } catch {}
    }
    wss.close();
  }
  // Flush the vault index before exiting (bounded by the hard exit below; the
  // index is written atomically, so an interrupted save keeps the old file).
  stopRag().finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '7440', 10);

server.listen(PORT, HOST, () => {
  log(`server v${getVersion()} listening on http://${HOST}:${PORT}`);
  // Vault RAG: load the persisted index, watch the vault and sync it in the
  // background — never on the startup path (/health is up already), and
  // until the index exists queries just fall back to CAMPAIGN.md.
  startRag();
});