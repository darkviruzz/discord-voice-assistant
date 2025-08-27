## Title

Discord Voice Assistant – Bot + LAN Audio Server (per-Speaker Uplink, low-latency Downlink)

## Überblick

Dieses Monorepo enthält:

* **Bot (apps/bot)**

  * Discord-Recorder/Player: pro Sprecher WAV-Chunks, zeitkorrekter Session-Mix (HQ/LQ), zusätzlich je **Sprecher HQ/LQ-Mix**.
  * **Ohne Server voll nutzbar**: Aufnehmen, Speichern, Mischen.
  * Optional: **per-Speaker Uplink** (20-ms Frames, Opus/PCM passthrough) an den LAN-Server.
  * Downlink-Wiedergabe mit **Jitter-/Playout-Puffer** und **Gating** (spielt nur bei Stille).

* **Server (apps/server)** *(optional)*

  * Nimmt per-Speaker Uplink an (kein Mix, kein Re-encode im Bot nötig).
  * Schickt Downlink-Frames (20-ms Opus) an den Bot.
  * Control-WS (JSON) für Befehle (z. B. Testton, künftig TTS/STT-Hooks).
  * Für **Windows** oder Linux geeignet; keine speziellen Abhängigkeiten außer Node.js.

## Architektur

* **Transport:** Drei Kanäle

  * `/uplink` (Binär, 20-ms-Frames; pro Sprecher; Codecflag: `opus` bevorzugt passthrough),
  * `/downlink` (Binär, 20-ms Opus → Bot),
  * `/control` (WebSocket JSON; Events/Befehle/Backpressure).
* **Gating/Playout im Bot:** Wiedergabe startet nur, wenn `activeSpeakers.size == 0` für ≥ `GATE_MS`. Bei Unterbrechung pausieren und mit Puffer fortsetzen. Optional „Pre-roll“: beim Resume ein paar vorangehende Frames erneut senden (später).
* **Latenz:** LAN-Ziel 0,5–2,0 s end-to-end (Transport << 5 ms; Rest Puffer + STT/TTS/LLM).

## Konfiguration

### Bot – `apps/bot/.env.example`

```
DISCORD_TOKEN=...
GUILD_ID=...

# Daten
DATA_DIR=/opt/discord-recorder/data
DEBUG=1
SESSION_IDLE_HOURS=4

# Uplink (optional; Server nur bei Bedarf aktiv)
UPLINK_PROTO=ws
UPLINK_HOST=192.168.20.101
UPLINK_PORT=7440
UPLINK_CODEC=opus       # opus|pcm
UPLINK_OPUS_BITRATE=32000

# Downlink/Control (optional)
DOWNLINK_WS_URL=ws://192.168.20.101:7440/downlink
CONTROL_WS_URL=ws://192.168.20.101:7440/control
CONTROL_BEARER=...

# Wiedergabe (Gating)
GATE_MS=400
JITTER_MS=200
PLAYOUT_MS=1000
PLAYOUT_MAX_MS=2000
```

### Server – `apps/server/.env.example`

```
HOST=0.0.0.0
PORT=7440
CONTROL_BEARER=changeme
SESSION_SECRET=
```

## Installation

### Bot (empfohlen als systemd-Dienst)

```bash
# im Repo-Root
npm install
cp apps/bot/.env.example apps/bot/.env
# .env ausfüllen (Token/Guild/…)
npm run register
npm run start:bot   # zum Testen im Vordergrund
```

**systemd** (Deploy-Beispiel):

```
[Unit]
Description=Discord Audio Recorder Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/discord-voice-assistant/apps/bot
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
```

### Server (Windows)

* Node.js LTS installieren.
* Repo klonen oder nur `apps/server` kopieren.
* `npm install` in `apps/server`, `.env` füllen, `npm start`.
* Optional als Dienst via **NSSM** einrichten (nicht erforderlich).

## Nutzung (ohne Server)

* In Discord in den Voice-Channel, **/join** → Aufnahme startet.
* **/save-session** → erzeugt:

  * `session_mix_hq.ogg`, `session_mix_lq.ogg`
  * `user_<name>_hq.ogg`, `user_<name>_lq.ogg`
  * WAV-Chunks + `session.json` (Timeline).
* **/leave** verlässt den Channel.
* Bei Neustart werden inaktive Sessions (>4 h) automatisch finalisiert.

## Nutzung (mit Server, on-demand)

* Server starten (Windows).
* Bot verbindet optional `/uplink` (per-Speaker), `/downlink` (Abo), `/control`.
* Test: `/control` → `{"type":"play_test_tone","sessionId":"<id>"}` sendet 20-ms-Opus-Frames an den Bot; Bot spielt nur bei Stille (Gating).

## Roadmap (nur, wenn Server läuft)

* STT/LLM/TTS-Pipelines (ollama lokal, OpenAI für Spezialaufgaben).
* „Pre-roll“ beim Resume (einige Frames zurückspulen).
* Backpressure/Flow-Control via `buffer_status`.


## Lizenz
UNLICENSED
