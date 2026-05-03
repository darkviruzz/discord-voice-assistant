## Titel

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
  * Control-WS (JSON) für Befehle (z. B. Testton, TTS/STT-Hooks).
  * Für **Windows** oder Linux geeignet; keine speziellen Abhängigkeiten außer Node.js.

## Architektur

* **Transport:** Drei Kanäle

  * `/uplink` (Binär, 20-ms-Frames; pro Sprecher; Codecflag: `opus` bevorzugt passthrough),
  * `/downlink` (Binär, 20-ms Opus → Bot),
  * `/control` (WebSocket JSON; Events/Befehle/Backpressure).
* **Gating/Playout im Bot:** Wiedergabe startet nur, wenn `activeSpeakers.size == 0` für ≥ `GATE_MS`. Bei Unterbrechung pausieren; beim Fortsetzen werden die letzten ~1000 ms aus dem Wiedergabe-History-Buffer erneut eingespielt.
* **Latenz:** LAN-Ziel 0,5–2,0 s end-to-end (Transport << 5 ms; Rest Puffer + STT/TTS/LLM).

## Konfiguration

### Bot – `apps/bot/.env`

```env
DISCORD_TOKEN=
GUILD_ID=

DATA_DIR=/opt/discord-recorder/data
DEBUG=1
SESSION_IDLE_HOURS=4

SERVER_BASE_URL=ws://192.168.20.101:7440
CONTROL_BEARER=changeme

UPLINK_CODEC=opus
UPLINK_OPUS_BITRATE=32000

GATE_MS=80
PLAYOUT_MAX_MS=1500
INTERRUPT_MIN_MS=400
RESUME_GATE_MS=900
```

| Variable | Standard | Beschreibung |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot-Token aus [discord.com/developers](https://discord.com/developers). Pflichtfeld. |
| `GUILD_ID` | — | Discord-Server-ID. Rechtsklick auf den Server → „ID kopieren" (Developer Mode nötig). Pflichtfeld. |
| `DATA_DIR` | `/opt/discord-recorder/data` | Verzeichnis für WAV-Chunks, Session-JSON und Mischungen. Wird automatisch angelegt. |
| `DEBUG` | — | Auf `1` setzen für ausführliche Logs (STT-Transkripte, Wake-Word-Ergebnis, LLM-Antworten). |
| `SESSION_IDLE_HOURS` | `4` | Stunden Inaktivität bis zur automatischen Session-Finalisierung beim Serverneustart. |
| `SERVER_BASE_URL` | — | Basis-URL des Servers, z. B. `ws://192.168.20.101:7440`. Bevorzugte Einstellung — überschreibt die Ableitung aus `CONTROL_WS_URL`. |
| `UPLINK_PROTO` | `ws` | Protokoll für den Uplink-WebSocket. `ws` für LAN, `wss` für TLS. |
| `UPLINK_HOST` | — | IP-Adresse oder Hostname des Servers. Nur nötig wenn `SERVER_BASE_URL` nicht gesetzt. |
| `UPLINK_PORT` | — | TCP-Port des Servers (z. B. `7440`). Nur nötig wenn `SERVER_BASE_URL` nicht gesetzt. |
| `UPLINK_CODEC` | `opus` | Codec für Uplink-Frames. `opus` empfohlen (kein Re-Encode im Bot). `pcm` sendet rohe 16-bit PCM-Daten. |
| `UPLINK_OPUS_BITRATE` | `32000` | Opus-Bitrate in bps für den Uplink. 32000 ist ein guter Kompromiss für Sprache. |
| `DOWNLINK_WS_URL` | — | Direkte WebSocket-URL für den Downlink-Kanal. Veraltet — `SERVER_BASE_URL` verwenden. |
| `CONTROL_WS_URL` | — | Direkte WebSocket-URL für die Control-Plane, z. B. `ws://192.168.20.101:7440/control`. Veraltet — `SERVER_BASE_URL` verwenden. |
| `CONTROL_BEARER` | — | Bearer-Token zur Authentifizierung gegenüber dem Server. Muss mit dem Server-`CONTROL_BEARER` übereinstimmen. |
| `GATE_MS` | `80` | Mindest-Stille in ms nach dem letzten Sprecher, bevor die Wiedergabe starten darf (normales Gating ohne Unterbrechung). Kleinere Werte = schnellerer Start, aber mehr Überschneidungen. |
| `PLAYOUT_MAX_MS` | `1500` | Frames die älter als dieser Wert sind (in ms) werden im JitterBuffer als veraltet verworfen. Verhindert Wiedergabe von zu alten Frames bei langen Pausen. |
| `INTERRUPT_MIN_MS` | `400` | Mindest-Sprechdauer in ms, ab der eine Aussage als echte Unterbrechung gewertet wird. Kürzere Geräusche (Husten, Lachen, Hintergrundgeräusche) werden ignoriert. |
| `RESUME_GATE_MS` | `900` | Stille-Dauer in ms nach dem Ende einer Unterbrechung, bevor die Wiedergabe fortgesetzt wird. Gibt dem Spieler Zeit, seinen Satz zu beenden. |

### Server – `apps/server/.env`

```env
HOST=0.0.0.0
PORT=7440
CONTROL_BEARER=changeme
SESSION_SECRET=
DEBUG=1

WHISPER_URL=http://localhost:8080
WHISPER_LANGUAGE=de

OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
SYSTEM_PROMPT_FILE=./prompt.txt
HISTORY_TURNS=6

TTS_PROVIDER=piper
TTS_URL=http://localhost:5000

WAKE_WORD=Rabenauge
WAKE_WORD_FUZZY=true
WAKE_WORD_POSITION=3
```

#### Transport

| Variable | Standard | Beschreibung |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind-Adresse des Servers. `0.0.0.0` lauscht auf allen Netzwerkschnittstellen. |
| `PORT` | `7440` | TCP-Port für alle WebSocket-Endpunkte (`/uplink`, `/downlink`, `/control`). |
| `CONTROL_BEARER` | `changeme` | Bearer-Token für die Control-Plane. **Unbedingt ändern.** Muss mit dem Bot-`CONTROL_BEARER` übereinstimmen. |
| `SESSION_SECRET` | — | Optionales Secret für interne Session-Signierung. |
| `DEBUG` | — | Auf `1` setzen für ausführliche Pipeline-Logs (STT, LLM, TTS, Frame-Counts). |

#### STT (Speech-to-Text)

| Variable | Standard | Beschreibung |
|---|---|---|
| `WHISPER_URL` | `http://localhost:8080` | URL des whisper.cpp HTTP-Servers (`/inference`-Endpoint). |
| `WHISPER_LANGUAGE` | `auto` | Sprache für Whisper. `de` für Deutsch, `en` für Englisch, `auto` für automatische Erkennung. `auto` ist etwas langsamer. |

#### LLM

| Variable | Standard | Beschreibung |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | URL des Ollama-Servers. |
| `OLLAMA_MODEL` | `llama3` | Zu verwendendes Ollama-Modell. Muss zuvor mit `ollama pull <modell>` geladen worden sein (z. B. `llama3.2`). |
| `SYSTEM_PROMPT_FILE` | — | Pfad zu einer UTF-8-Textdatei mit dem System-Prompt, z. B. `./prompt.txt`. **Empfohlen** — kein Escaping nötig, da Dateiinhalt direkt gelesen wird. Relativ zum Arbeitsverzeichnis beim Serverstart (`apps/server/`). Hat Vorrang vor `SYSTEM_PROMPT`. |
| `SYSTEM_PROMPT` | *(eingebaut)* | System-Prompt als Inline-String in der `.env`. Fallback wenn `SYSTEM_PROMPT_FILE` nicht gesetzt. Bei komplexen Prompts mit Anführungszeichen oder JSON-Syntax schwer zu escapen — `SYSTEM_PROMPT_FILE` bevorzugen. |
| `HISTORY_TURNS` | `6` | Anzahl der Gesprächs-Runden (User+Assistant je = 1 Turn), die als Kontext an Ollama übergeben werden. Höhere Werte = besserer Kontext, aber mehr Token-Verbrauch. |

#### TTS (Text-to-Speech)

| Variable | Standard | Beschreibung |
|---|---|---|
| `TTS_PROVIDER` | `piper` | TTS-Backend: `piper` für lokalen Piper/KokoroTTS-Server, `elevenlabs` für die ElevenLabs-Cloud-API. |
| `TTS_URL` | `http://localhost:5000` | URL des lokalen TTS-Servers (nur bei `TTS_PROVIDER=piper`). Erwartet `POST /synthesize` mit JSON `{text, model, speaker_id}` → WAV-Response. |
| `ELEVENLABS_API_KEY` | — | API-Key für ElevenLabs (nur bei `TTS_PROVIDER=elevenlabs`). |
| `ELEVENLABS_VOICE_ID` | `EXAVITQu4vr4xnSDxMaL` | Voice-ID für ElevenLabs. Standard ist eine englische Männerstimme; für Deutsch eine passende Stimme aus dem ElevenLabs-Katalog wählen. |

#### Wake-Word

| Variable | Standard | Beschreibung |
|---|---|---|
| `WAKE_WORD` | `Rabenauge` | Aktivierungswort. Der Bot verarbeitet eine Aussage nur, wenn dieses Wort erkannt wird. Groß-/Kleinschreibung wird ignoriert. |
| `WAKE_WORD_FUZZY` | `true` | Fuzzy-Matching mit Levenshtein-Distanz ≤ 2. Erkennt Vertipper und Aussprache-Varianten (z. B. „Rabenaugen", „Rabenoge"). Auf `false` setzen für exaktes Matching. |
| `WAKE_WORD_POSITION` | `3` | Maximale Wortposition des Wake-Words im Transkript. `3` = Wake-Word muss in den ersten 3 Wörtern stehen. `0` = überall im Satz erlaubt. Verhindert False-Positives wenn das Wake-Word mitten in einer Aussage vorkommt. |
| `STT_SILENCE_THRESH` | `300` | RMS-Schwellwert für Silence-Detection beim Aufteilen langer Utterances. Frames mit RMS < Schwellwert gelten als Stille. Muss ggf. je nach Mikrofon und Raumakustik angepasst werden — siehe Hinweis unten. |

> **TODO — Silence-Detection kalibrieren**: Die Silence-Erkennung (`STT_SILENCE_THRESH`) muss möglicherweise je nach Mikrofon und Raumakustik angepasst werden. Das Entfernen des früheren 6-Sekunden-Ringbuffers hat die Transkriptions-Erkennung bereits deutlich verbessert. Falls lange Fragen trotzdem abgeschnitten werden: `DEBUG=1` setzen und die Meldung `pipeline: Xs → N silence-split chunks` im Serverlog beobachten. Erscheint keine Aufteilungs-Meldung bei einer >30-Sekunden-Aufnahme, ist der Schwellwert zu niedrig (zu viel Hintergraudrauschen wird als Sprache gewertet) → `STT_SILENCE_THRESH` erhöhen (z. B. auf `500`–`800`).

### Piper Speaker-IDs (de_DE-thorsten_emotional-medium)

Der eingebaute System-Prompt weist das LLM an, je nach Kontext eine Speaker-ID zurückzugeben:

| ID | Emotion |
|----|---------|
| 0 | Fröhlich |
| 1 | Wütend |
| 2 | Angewidert |
| 3 | Betrunken |
| 4 | Neutral (Standard) |
| 5 | Schläfrig |
| 6 | Überrascht |
| 7 | Flüsternd |

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

### System-Prompt als Datei einrichten

Statt eines Inline-Strings in `.env` eine Datei anlegen:

```
apps/server/prompt.txt
```

Inhalt (Beispiel — beliebiger Text, kein Escaping nötig):

```
Du bist Rabenauge, ein Assistent für eine Pen-and-Paper-Runde.
Antworte IMMER als JSON-Objekt mit exakt diesen Feldern:
  "text"      : deine gesprochene Antwort
  "speaker_id": 0-7 passend zur Stimmung (Standard: 4)
  "model"     : "emotional" oder "high"

Beispiel: {"text":"Baron Kelthur herrschte mit eiserner Faust.","speaker_id":4,"model":"high"}
```

In `apps/server/.env`:

```
SYSTEM_PROMPT_FILE=./prompt.txt
```

`prompt.txt` enthält kampagnenspezifische Inhalte und sollte ins `.gitignore`.

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
* Wake-Word sprechen: *„Rabenauge, wer ist Baron Kelthur?"* → Bot antwortet per Sprache im Voice-Channel.

## AI Services Setup — Windows 11 / AMD GPU (RX 6800 XT)

Setup-Anleitung für die drei lokalen AI-Services.

> **Voraussetzungen:**
> - Windows 11, x64
> - AMD Radeon RX 6800 XT (16 GB VRAM)
> - AMD Ryzen CPU (24 Threads)
> - PowerShell 5.1+ (vorinstalliert)
> - Node.js 20+ (für den Discord-Server)
> - Python 3.10+ (`python --version`)

### Übersicht

| Service | Port | Zweck | Technologie |
|---------|------|-------|-------------|
| Whisper | 8080 | Sprache → Text (STT) | whisper.cpp + Vulkan |
| Ollama | 11434 | Text → Antwort (LLM) | llama3.2 |
| Piper | 5000 | Text → Sprache (TTS) | Piper + FastAPI |

Alle drei Services müssen laufen bevor der Discord-Server gestartet wird.

---

### Service 1: Whisper (Speech-to-Text)

#### Installation

**1. Vulkan-Binary herunterladen**

Öffne PowerShell und führe aus:

```powershell
# Verzeichnis erstellen
New-Item -ItemType Directory -Path "C:\Users\$env:USERNAME\Programme\whisper-vulkan" -Force
cd "C:\Users\$env:USERNAME\Programme\whisper-vulkan"
```

Lade die Vulkan-Version manuell herunter (AMD GPU-Unterstützung):
- Quelle: https://github.com/jerryshell/whisper.cpp-windows-vulkan-bin/releases
- Dateiname: `whisper.cpp-windows-vulkan.zip` (oder äquivalent für deine Version)
- Entpacken nach: `C:\Users\<NAME>\Programme\whisper-vulkan\`

> **Warum Vulkan?** Die Standard-Binaries unterstützen nur NVIDIA (cuBLAS) oder CPU (BLAS).
> Vulkan läuft auf AMD GPUs und reduziert die Transkriptionszeit von ~40s auf ~6s.

**2. Modell herunterladen**

```powershell
# Modell-Verzeichnis erstellen
New-Item -ItemType Directory -Path "C:\Users\$env:USERNAME\Programme\whisper-vulkan\models" -Force
cd "C:\Users\$env:USERNAME\Programme\whisper-vulkan\models"

# Deutsches Medium-Modell (q5_0 quantisiert, ~540 MB)
& "C:\Windows\System32\curl.exe" -L -o ggml-medium-q5_0.bin `
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin"
```

Download-Dauer: ~3–5 Minuten.

**3. Modell testen (optional)**

```powershell
cd "C:\Users\$env:USERNAME\Programme\whisper-vulkan"

.\whisper-server.exe `
    --model .\models\ggml-medium-q5_0.bin `
    -f .\test-wavs\deine-testdatei.wav `
    --language de
```

Erwartet: Ausgabe der erkannten Sprache in ~6 Sekunden für eine 11-Sekunden-Aufnahme.

#### Server starten

**Batch-Script:** `C:\Users\<NAME>\Programme\whisper-vulkan\start-whisper.bat`

```batch
@echo off
cd /d C:\Users\%USERNAME%\Programme\whisper-vulkan
echo ========================================
echo  Whisper Server (Vulkan - AMD RX 6800 XT)
echo  Modell: ggml-medium-q5_0.bin
echo  Port: 8080
echo ========================================
echo.
echo Server startet...
echo Zum Beenden: Strg+C
echo.

whisper-server.exe --model ./models/ggml-medium-q5_0.bin --port 8080 --language de

echo.
echo Server beendet.
pause
```

#### Health-Check

```powershell
& "C:\Windows\System32\curl.exe" http://localhost:8080/health
# Erwartet: {"status":"ok"}
```

#### Transkriptions-Test

```powershell
& "C:\Windows\System32\curl.exe" `
    -X POST http://localhost:8080/inference `
    -F "file=@C:\Users\$env:USERNAME\Programme\whisper-vulkan\test-wavs\test.wav" `
    -F "language=de"
# Erwartet: {"text":" Hallo, dies ist ein Test."}
```

#### Modell-Vergleich (Referenz)

Getestet mit 11s deutschem Audio:

| Modell | Zeit | Qualität |
|--------|------|----------|
| ggml-small.bin | 18.69s | Encoding-Fehler, Wortfehler |
| ggml-medium-q5_0.bin (CPU) | 41.64s | Gut |
| ggml-medium-q5_0.bin (Vulkan) | **6.33s** | **Sehr gut** ✅ |

> **Hinweis zu VAD:** Voice Activity Detection (`--vad`) ist verfügbar, verschlechtert aber
> bei kurzen Äußerungen die Erkennungsqualität. Für den Bot-Einsatz deaktiviert lassen.

---

### Service 2: Ollama (Large Language Model)

#### Installation

**1. Installer herunterladen und ausführen**

```powershell
& "C:\Windows\System32\curl.exe" -L -o ollama-installer.exe `
    "https://ollama.com/download/OllamaSetup.exe"

Start-Process .\ollama-installer.exe -Wait
```

Ollama installiert sich als **Windows-Service** und startet automatisch beim Boot.

**2. Deutsches Modell herunterladen**

```powershell
# Primärmodell (3.2B, ~2 GB, gut für Deutsch)
ollama pull llama3.2

# Optional: Größeres Modell für bessere Antwortqualität (nutzt mehr VRAM)
# ollama pull llama3.1:8b
```

**3. Installierte Modelle prüfen**

```powershell
& "C:\Windows\System32\curl.exe" http://localhost:11434/api/tags
```

Erwartet: JSON mit `llama3.2:latest` in der Modell-Liste.

#### Betrieb

Ollama läuft als **Windows-Hintergrunddienst** — kein manueller Start nötig.

> **Wichtig:** Nicht `ollama serve` im Terminal ausführen wenn der Service bereits läuft.
> Das erzeugt einen Konflikt und die zweite Instanz findet die Modelle nicht.

#### Logs live beobachten

```powershell
Get-Content "$env:LOCALAPPDATA\Ollama\server.log" -Wait -Tail 30
```

**Batch-Script für Logs:** `C:\Users\<NAME>\Programme\ollama-logs.bat`

```batch
@echo off
echo ========================================
echo  Ollama Logs (live)
echo  Modell: llama3.2 | Port: 11434
echo ========================================
echo.
powershell -Command "Get-Content '$env:LOCALAPPDATA\Ollama\server.log' -Wait -Tail 30"
pause
```

#### Health-Check

```powershell
& "C:\Windows\System32\curl.exe" http://localhost:11434/api/tags
# Erwartet: {"models":[{"name":"llama3.2:latest",...}]}
```

#### Chat-Test

```powershell
# JSON ohne BOM schreiben (wichtig für curl auf Windows)
[System.IO.File]::WriteAllText(
    "$env:TEMP\ollama-test.json",
    '{"model":"llama3.2","stream":false,"messages":[{"role":"system","content":"Du bist Rabenauge, ein hilfreicher Assistent fuer eine Pen-and-Paper Runde. Antworte kurz."},{"role":"user","content":"Was weisst du ueber Baron Kelthur?"}]}',
    [System.Text.UTF8Encoding]::new($false)
)

& "C:\Windows\System32\curl.exe" `
    -X POST http://localhost:11434/api/chat `
    -H "Content-Type: application/json" `
    -d "@$env:TEMP\ollama-test.json"
```

Erwartet: JSON-Antwort mit `"role":"assistant"` und deutschem Text.

> **Performance-Referenz:**
> - Erster Request: ~5s (Modell wird in VRAM geladen)
> - Folge-Requests: ~300ms (Modell bleibt im VRAM)

---

### Service 3: Piper TTS (Text-to-Speech)

#### Installation

**1. Piper-Binary herunterladen**

```powershell
New-Item -ItemType Directory -Path "C:\Users\$env:USERNAME\Programme\piper" -Force
cd "C:\Users\$env:USERNAME\Programme\piper"

& "C:\Windows\System32\curl.exe" -L -o piper.zip `
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip"

Expand-Archive -Path piper.zip -DestinationPath . -Force
```

**2. Deutsche Stimmen herunterladen**

```powershell
New-Item -ItemType Directory -Path "C:\Users\$env:USERNAME\Programme\piper\voices" -Force
cd "C:\Users\$env:USERNAME\Programme\piper\voices"

# Stimme 1: Thorsten High (klare, neutrale Stimme)
& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten-high.onnx `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx"

& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten-high.onnx.json `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx.json"

# Stimme 2: Thorsten Emotional Medium (8 Emotionen)
& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten_emotional-medium.onnx `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx"

& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten_emotional-medium.onnx.json `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx.json"
```

**3. Python-Umgebung einrichten**

```powershell
cd "C:\Users\$env:USERNAME\Programme\piper"

python -m venv piper
.\piper\Scripts\activate
pip install fastapi uvicorn
```

**4. HTTP-Server-Skript erstellen**

Speichere als `C:\Users\<NAME>\Programme\piper\server.py` (UTF-8 ohne BOM):

```python
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
import subprocess, tempfile, os

app = FastAPI()

PIPER_EXE = r"C:\Users\<NAME>\Programme\piper\piper.exe"

MODELS = {
    "emotional": r"C:\Users\<NAME>\Programme\piper\voices\de_DE-thorsten_emotional-medium.onnx",
    "high":      r"C:\Users\<NAME>\Programme\piper\voices\de_DE-thorsten-high.onnx",
}

# Speaker IDs (nur fuer model="emotional"):
# 0=Frohlich  1=Wutend   2=Angewidert  3=Betrunken
# 4=Neutral   5=Schlafrig 6=Ueberrascht 7=Flusternd

class TTSRequest(BaseModel):
    text: str
    model: str = "emotional"
    speaker_id: int = 4  # Default: Neutral

@app.post("/synthesize")
async def synthesize(req: TTSRequest):
    model_path = MODELS.get(req.model, MODELS["emotional"])

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        outfile = f.name

    cmd = [PIPER_EXE, "--model", model_path, "--output_file", outfile]
    if req.model == "emotional":
        cmd += ["--speaker", str(req.speaker_id)]

    subprocess.run(cmd, input=req.text.encode("utf-8"), capture_output=True)

    with open(outfile, "rb") as f:
        audio = f.read()
    os.unlink(outfile)

    return Response(content=audio, media_type="audio/wav")

@app.get("/health")
async def health():
    return {"status": "ok"}
```

> **Wichtig:** `<NAME>` durch deinen Windows-Benutzernamen ersetzen.

#### Server starten

**Batch-Script:** `C:\Users\<NAME>\Programme\piper\start-piper.bat`

```batch
@echo off
cd /d C:\Users\%USERNAME%\Programme\piper
echo ========================================
echo  Piper TTS HTTP Server
echo  Modelle: thorsten_emotional-medium
echo           thorsten-high
echo  Port: 5000
echo.
echo  Speaker IDs (emotional):
echo    0=Frohlich   1=Wutend    2=Angewidert
echo    3=Betrunken  4=Neutral   5=Schlafrig
echo    6=Ueberrascht 7=Flusternd
echo ========================================
echo.
call .\piper\Scripts\activate.bat
uvicorn server:app --host 0.0.0.0 --port 5000

echo.
echo Server beendet.
pause
```

#### Health-Check

```powershell
& "C:\Windows\System32\curl.exe" http://localhost:5000/health
# Erwartet: {"status":"ok"}
```

#### TTS-Tests

```powershell
# Test 1: Neutral (emotional, speaker 4)
[System.IO.File]::WriteAllText(
    "$env:TEMP\tts-neutral.json",
    '{"text":"Hallo Abenteurer, ich bin Rabenauge. Wie kann ich euch helfen?","model":"emotional","speaker_id":4}',
    [System.Text.UTF8Encoding]::new($false)
)
& "C:\Windows\System32\curl.exe" -X POST http://localhost:5000/synthesize `
    -H "Content-Type: application/json" `
    -d "@$env:TEMP\tts-neutral.json" `
    --output test-neutral.wav
Start-Process test-neutral.wav

# Test 2: Flüsternd (speaker 7)
[System.IO.File]::WriteAllText(
    "$env:TEMP\tts-fluster.json",
    '{"text":"Vorsicht, da vorne lauert etwas im Schatten...","model":"emotional","speaker_id":7}',
    [System.Text.UTF8Encoding]::new($false)
)
& "C:\Windows\System32\curl.exe" -X POST http://localhost:5000/synthesize `
    -H "Content-Type: application/json" `
    -d "@$env:TEMP\tts-fluster.json" `
    --output test-fluster.wav
Start-Process test-fluster.wav

# Test 3: High (klare Stimme ohne Emotion)
[System.IO.File]::WriteAllText(
    "$env:TEMP\tts-high.json",
    '{"text":"Baron Kelthur regiert seit zwanzig Jahren die Nordprovinz.","model":"high"}',
    [System.Text.UTF8Encoding]::new($false)
)
& "C:\Windows\System32\curl.exe" -X POST http://localhost:5000/synthesize `
    -H "Content-Type: application/json" `
    -d "@$env:TEMP\tts-high.json" `
    --output test-high.wav
Start-Process test-high.wav
```

---

### Gemeinsamer Health-Check (alle Services)

```powershell
Write-Host "=== Service Health Check ===" -ForegroundColor Cyan

$w = & "C:\Windows\System32\curl.exe" -s http://localhost:8080/health
Write-Host "Whisper  (8080): $w" -ForegroundColor $(if ($w -match "ok") {"Green"} else {"Red"})

$o = & "C:\Windows\System32\curl.exe" -s http://localhost:11434/api/tags
Write-Host "Ollama  (11434): $(if ($o -match 'llama') {'OK - llama3.2 geladen'} else {'FEHLER'})" `
    -ForegroundColor $(if ($o -match "llama") {"Green"} else {"Red"})

$p = & "C:\Windows\System32\curl.exe" -s http://localhost:5000/health
Write-Host "Piper    (5000): $p" -ForegroundColor $(if ($p -match "ok") {"Green"} else {"Red"})
```

Speichern als `check-services.ps1` im Repo-Root, ausführen mit:

```powershell
powershell -ExecutionPolicy Bypass -File .\check-services.ps1
```

---

### Startreihenfolge

```
1. Ollama        → läuft automatisch als Windows-Service beim Boot
2. Whisper       → start-whisper.bat (C:\...\whisper-vulkan\)
3. Piper         → start-piper.bat   (C:\...\piper\)
4. Discord-Server→ npm start         (apps/server/)
5. Discord-Bot   → auf Linux: npm run start:bot
```

---

### Troubleshooting

| Symptom | Ursache | Lösung |
|---------|---------|--------|
| Whisper: `Could not connect` | Server nicht gestartet | `start-whisper.bat` ausführen |
| Whisper: `failed to read audio` | Falsches curl | `C:\Windows\System32\curl.exe` statt `curl` verwenden |
| Ollama: `model not found` | Zweite `ollama serve` Instanz | Terminal-Instanz beenden, nur Service nutzen |
| Ollama: `connection refused` | Service nicht gestartet | Startmenü → Ollama → starten |
| Piper: `connection refused` | FastAPI nicht gestartet | `start-piper.bat` ausführen |
| Piper: langer Pfad-Fehler | Falscher Username in server.py | `<NAME>` → deinen Benutzernamen ersetzen |
| Alle Services: Port belegt | Alter Prozess läuft noch | `netstat -ano \| findstr :8080` → PID beenden |

#### Port-Konflikt debuggen

```powershell
netstat -ano | findstr ":8080"
netstat -ano | findstr ":11434"
netstat -ano | findstr ":5000"

# Prozess nach PID beenden (PID aus letzter Spalte):
Stop-Process -Id <PID> -Force
```

## Lizenz
UNLICENSED
