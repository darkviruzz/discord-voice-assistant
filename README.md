## README.md (vollständig, zum Einfügen ins Repo)

### Title

Discord Voice Assistant – Bot + LAN Audio Server (per-Speaker Uplink, low-latency Downlink)

### Überblick

Dieses Monorepo enthält:

* **Bot (`apps/bot`)**: Discord-Recorder und -Player. Er verwaltet Audio-Sessions in Voice-Channels und zeichnet jede Sprecherin und jeden Sprecher getrennt auf. Zusätzlich erstellt er einen zeitlich korrekten Mix des gesamten Gesprächs. Parallel sendet er pro Sprecher 20-ms-Frames im Original-Codec (kein Mix, kein unnötiges Re-Encoding) an den LAN-Server. Eingehende Downlink-Frames vom Server werden in einem Jitter-/Playout-Puffer gesammelt und nur in Sprechpausen abgespielt (Gating), sodass Systemmeldungen oder LLM-Antworten nicht ins Wort fallen.
* **Server (`apps/server`)**: Nimmt Uplink-Frames an (Opus/PCM), verwaltet Sessions & Speaker, streamt Downlink (Opus 20 ms), bietet Control-WebSocket (JSON) und Hooks für **ollama** (lokal) sowie **OpenAI** (Spezialfälle).
* **Protocol (`packages/protocol`)**: Gemeinsames Binär-Protokoll (Header, Parser, HMAC), Zeit/Seq-Hilfen.

### Architektur

* **Transport:** Drei Kanäle

  * `/uplink` (Binär, 20-ms-Frames; pro Sprecher; Codecflag: `opus` bevorzugt passthrough),
  * `/downlink` (Binär, 20-ms Opus → Bot),
  * `/control` (WebSocket JSON; Events/Befehle/Backpressure).
* **Gating/Playout im Bot:** Wiedergabe startet nur, wenn `activeSpeakers.size == 0` für ≥ `GATE_MS`. Bei Unterbrechung pausieren und mit Puffer fortsetzen. Optional „Pre-roll“: beim Resume ein paar vorangehende Frames erneut senden (später).
* **Latenz:** LAN-Ziel 0,5–2,0 s end-to-end (Transport << 5 ms; Rest Puffer + STT/TTS/LLM).

### Voraussetzungen

* Node.js ≥ 20, ffmpeg (für Offline-Mix im Bot), Discord-App/Token.
* Netzwerk: Bot auf **192.168.20.137**, Server auf **192.168.20.101** (anpassbar).
* Optional: ollama lokal (Standardantworten), OpenAI API Key für Spezialaufgaben.

### Quickstart (lokal)

```bash
# im Repo-Root
cp .env.example .env  # optional
npm install
# Bot- und Server-spezifische Envs
cp apps/bot/.env.example apps/bot/.env
cp apps/server/.env.example apps/server/.env
# Envs anpassen (IPs/Ports/Token)
npm run dev
```

### Deployment (Proxmox – Beispiel)

* **Bot**: LXC `20021` auf Node `pve-jn` (`discord-bot-jn`, IP 192.168.20.137).

  * `apps/bot` deployen, `.env` setzen, **systemd**: `deploy/bot/systemd/discord-bot.service`.
* **Server**: VM/Container auf `pve-jn` oder separatem Node, IP **192.168.20.101**.

  * `apps/server` deployen, `.env` setzen, **systemd**: `deploy/server/systemd/discord-audio-server.service`.
* Optional **Docker**: Beide `Dockerfile`s und `docker-compose.yml` für schnellen lokalen Test, produktiv würde ich hier bei systemd bleiben (einfach, robust).

### Konfiguration (wichtige Variablen)

* **Bot (`apps/bot/.env`)**

  * `DISCORD_TOKEN`, `GUILD_ID`
  * Uplink: `UPLINK_PROTO=ws`, `UPLINK_HOST=192.168.20.101`, `UPLINK_PORT=7440`, `UPLINK_CODEC=opus`
  * Downlink/Control: `DOWNLINK_WS_URL=ws://192.168.20.101:7440/downlink`, `CONTROL_WS_URL=ws://192.168.20.101:7440/control`, `CONTROL_BEARER=...`
  * Playback: `GATE_MS=400`, `JITTER_MS=200`, `PLAYOUT_MS=1000`, `PLAYOUT_MAX_MS=2000`
* **Server (`apps/server/.env`)**

  * `HOST=0.0.0.0`, `PORT=7440`, `CONTROL_BEARER=...`
  * Optional: `SESSION_SECRET=...` für HMAC pro Frame
  * STT/LLM/TTS: `OLLAMA_URL`, `OLLAMA_MODEL`, `OPENAI_API_KEY`, `PIPER_PATH`, `PIPER_VOICE`

### Protokoll (20-ms Frames)

Header (Big-Endian):

```
magic(4)='UPLK'|'DNLK' | ver(1)=1 | flags(1):bit0 codec(0=pcm,1=opus) | rsv(2)
sessionId(8 u64) | userId(8 u64) | seq(4 u32) | ts_ms(8 u64, monotonic) | len(2 u16) | payload(len)
```

Optional HMAC über Header+Payload (separat über Control vereinbart).

### Tests

* **Downlink**: `/control` → `{ "type":"play_test_tone", "sessionId":"<u64>" }`
* **Uplink**: Bot verbindet `/uplink` und schickt pro Sprecher Frames (seq++/20 ms). Server zählt Frames und kann sie in Dateien oder STT schieben.

### Roadmap

* Bot-Pre-roll beim Resume (einige Frames zurückspulen).
* Per-Speaker Speicherung/Transkript (Server).
* STT-Pipeline: Whisper/WhisperX/Whisper-cpp oder cartesia; VAD/Segmentierung.
* Dynamische Priorisierung (System-Prompts vs. LLM-Antworten).
* TLS/Mutual-TLS, HMAC Pflicht.

### Lizenz

UNLICENSED
