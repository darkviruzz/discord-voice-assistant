import 'dotenv/config';
import http from 'http';
import express from 'express';
import { log } from './logger.js';
import { initUplinkWSS } from './uplink.js';
import { initDownlinkWSS } from './downlink.js';
import { initControlWSS } from './control.js';

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

const server = http.createServer(app);

initUplinkWSS(server,  { path: '/uplink'   });
initDownlinkWSS(server, { path: '/downlink' });
initControlWSS(server, { path: '/control', bearer: process.env.CONTROL_BEARER });

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '7440', 10);

server.listen(PORT, HOST, () => log(`server listening on http://${HOST}:${PORT}`));
