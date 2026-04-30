import 'dotenv/config';
import http from 'http';
import express from 'express';
import { URL } from 'url';
import { log, warn, debug } from './logger.js';
import { initUplinkWSS } from './uplink.js';
import { initDownlinkWSS } from './downlink.js';
import { initControlWSS } from './control.js';
import { checkBearer } from './auth.js';

const HB_INTERVAL_MS = 15000;

const app = express();
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

const server = http.createServer(app);

const bearer = process.env.CONTROL_BEARER;
const wssUplink   = initUplinkWSS(  { bearer });
const wssDownlink = initDownlinkWSS({});
const wssControl  = initControlWSS( { bearer });

// Single upgrade dispatcher: routes by URL path. Multiple WebSocketServer
// instances cannot share the same http server in `server: ...` mode without
// fighting over the upgrade event — first to fire path-rejects with 400.
// Using noServer: true and dispatching here avoids that.
const ROUTES = {
  '/uplink':   { wss: wssUplink,   requireBearer: true  },
  '/downlink': { wss: wssDownlink, requireBearer: false }, // bot needs no token to subscribe; protect via session/control later
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '7440', 10);

server.listen(PORT, HOST, () => log(`server listening on http://${HOST}:${PORT}`));
