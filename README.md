## Titel

Discord Voice Assistant – lokaler Pen-&-Paper-Recorder mit Transkript-Pipeline

## Hauptzweck

Der Bot sitzt während einer Pen-&-Paper-Session **kontinuierlich** im Discord-Voice-Channel und produziert ein **strukturiertes, lokal erzeugtes Transkript** als Eingabe für die Notizen, die die Spieler nebenbei stichpunktartig schreiben. Eine separate Cowork-Pipeline (außerhalb dieses Repos) verarbeitet die fertigen Notizen weiter zu einem Obsidian-Wiki über NPCs, Orte, Quests etc.

Alles läuft **lokal** — auch off-topic / privates Geplauder wird transkribiert, daher kein Cloud-STT/LLM.

**Hauptjob:** zuhören → pro Sprecher mitschneiden → bei `/finalize` ein chronologisch korrektes Transkript erzeugen.
**Nebenfeature:** Wake-Word-Aktivierung („Rabenauge, …") für In-Game-Lookups (NPC-Fragen, Regeln) per lokalem LLM. Antworten werden im Voice-Channel zurückgespielt und im Transkript markiert.

## Komponenten

* **Bot (apps/bot)** — Discord-Recorder. Nimmt pro Sprecher Opus-Frames auf (siehe [recorder.js](apps/bot/src/recorder.js)), speichert lokal als WAV. Sendet im Live-Modus optional Frames an den Server für sofortige Transkription. Wiedergabe von TTS-Antworten mit Jitter-/Playout-Puffer und Gating (spielt nur bei Stille).
* **Server (apps/server)** — STT-/LLM-/TTS-Pipeline (Whisper + Ollama + Piper, alle lokal). Empfängt Uplink-Frames, transkribiert pro Utterance, scannt auf Wake-Word, ruft LLM auf, generiert TTS-Antwort.
* **Cowork-Pipeline** *(extern)* — beobachtet den Transkript-Inbox-Ordner, reichert Spieler-Notizen an, baut/aktualisiert das Obsidian-Wiki.

## Operating Modes

Drei klar getrennte Betriebszustände:

| Modus | Trigger | Bot | Server |
|---|---|---|---|
| **Online-Live** | Server bei `/join` erreichbar (oder per Auto-SSH-Start hochgefahren) | streamt Audio zum Server, speichert lokal als Backup | live-Transkription, Wake-Word, LLM-Antworten, JSONL-Log |
| **Offline-Cache** | Server nach Auto-Start-Versuch nicht erreichbar | speichert nur lokal, **kein** Live-Transkript, **kein** Wake-Word | — |
| **Finalize** | manuell `/finalize` nach Session-Ende | schickt Backlog falls Offline-Cache | transkribiert Backlog, baut chronologisch-korrektes Markdown-Transkript, archiviert Audio als OGG/Opus, optional LLM-Summary |

Bei Server-Ausfall mitten in der Session fällt der Bot auf Offline-Cache zurück; `/finalize` füllt die Lücke nach.

## Transkript

Format: ein Markdown-File pro Session unter `apps/server/data/transcripts/<datum>-<session-id>/transcript.md`. Dieser Pfad ist die Inbox für die externe Cowork-Pipeline.

```markdown
# Session 2026-05-08

## 14:32 — Session-Start

**Markus**: Heute geht ihr also in den Wald, ihr seht...
  *[Tom unterbricht]* Moment, hab ich noch das Heiltrank-Inventar?
  *[Markus weiter]* ... einen alten Wegweiser. Ja Tom, hast du.

## 14:48 — Pause (5 min)

## 14:53 — Fortsetzung

**Anna**: Hey **Rabenauge**, wer war nochmal Baron Kelthur?
**Rabenauge**: Baron Kelthur war ein Halbork-Söldner …
**Anna**: Danke, **Stop**!
```

Konventionen:
* **Reines Transkript, kein AI-Enhancement** (kein Auto-Redact, kein Auto-Marker — bewusst, weil das LLM-Entscheidungen erfordern würde).
* Wake-Word („Rabenauge") und Stop-Word („Stop"/„Stopp") werden im Output **fett markiert**.
* Bot-Antworten erscheinen als eigener Sprecher („Rabenauge"), inline im Gesprächsfluss.
* Pausen >30 s erzeugen einen Header `## HH:MM — Pause (N min)`.
* **Monolog-Unterbrechungen** werden chronologisch eingebettet — der Algorithmus dafür rendert bei Finalize aus Whisper-Token-Timestamps und Discord-Per-User-Spuren-Timestamps (Live-Log ist chronologisch unkorrigiert; das finale Transkript ist sauber).

## Audio-Archiv

* **Während Aufnahme**: hohe Qualität (PCM 48 kHz / 16-bit WAV, ~1 GB/h pro Sprecher) — gibt Whisper bestmögliche Eingabe.
* **Nach Transkription / bei Finalize**: Originale werden zu OGG/Opus 32 kbps zusammengefasst (~430 MB für eine 6-h-Session mit 5 Spielern). 1–6 Monate aufbewahren für Rebuild/Quality-Checks, dann manuell löschen.

## Transport-Architektur (Detail)

Drei Kanäle zwischen Bot und Server:

* `/uplink` (Binär, 20-ms-Frames pro Sprecher; Codec `opus` Passthrough — kein Re-Encode im Bot)
* `/downlink` (Binär, 20-ms Opus → Bot)
* `/control` (WebSocket JSON; Events/Befehle/Backpressure)

**Gating/Playout im Bot**: Wiedergabe startet nur, wenn `activeSpeakers.size == 0` für ≥ `GATE_MS`. Bei Unterbrechung pausieren; beim Fortsetzen werden die letzten ~1000 ms aus dem Wiedergabe-History-Buffer erneut eingespielt.

**Latenz** (LAN-Ziel) für die Wake-Word-Antwort: 0,5–2,0 s end-to-end (Transport << 5 ms; Rest = Puffer + STT/TTS/LLM). Latenz ist **nicht** Tier-1-Optimierungsziel — Transkript-Qualität geht vor.

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

```powershell
# im Repo-Root
npm install
cp apps/server/.env.example apps/server/.env
# .env ausfüllen (CONTROL_BEARER, Pfade, Wake-Word)

# Alle Dienste starten (Whisper + Piper minimiert, Server im Vordergrund)
.\scripts\Start-VoiceAssistant.ps1

# Alternativ: 3 Split-Panes in Windows Terminal (Debugging)
.\scripts\Start-VoiceAssistant.ps1 -Mode all

# Alternativ: Hintergrundprozesse ohne Fenster (Autostart)
.\scripts\Start-VoiceAssistant.ps1 -Mode silent
```

**Pfade anpassen:** Die Variablen `$WhisperDir`, `$PiperDir` etc. am Anfang von
[`scripts/Start-VoiceAssistant.ps1`](scripts/Start-VoiceAssistant.ps1) auf dein System anpassen.

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

Der TTS-Server nutzt **piper via Python-API** (kein Subprocess-Aufruf der `piper.exe`).
Für GPU-Beschleunigung auf AMD-GPUs wird ein DirectML-Fork der piper-Library verwendet.

#### Installation

**1. Deutsche Stimmen herunterladen**

```powershell
New-Item -ItemType Directory -Path "C:\Users\$env:USERNAME\Programme\piper\voices" -Force
cd "C:\Users\$env:USERNAME\Programme\piper\voices"

# Stimme 1: Thorsten High (klare, neutrale Stimme)
& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten-high.onnx `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx"
& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten-high.onnx.json `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx.json"

# Stimme 2: Thorsten Emotional Medium (8 Emotionen, empfohlen)
& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten_emotional-medium.onnx `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx"
& "C:\Windows\System32\curl.exe" -L -o de_DE-thorsten_emotional-medium.onnx.json `
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx.json"
```

**2. Python-Umgebung einrichten (DirectML-Fork)**

Der DirectML-Fork erweitert piper-tts um GPU-Support via `PIPER_USE_DIRECTML=1`.
Ohne den Fork läuft der Server nur auf CPU.

```powershell
# Fork installieren (einmalig):
cd "C:\Users\$env:USERNAME\Programme\piper-directml-fork"
python -m venv venv
.\venv\Scripts\activate
pip install -e .           # piper-tts aus dem Fork
pip install fastapi uvicorn
```

Die Python-Dependencies sind in [`services/piper/requirements.txt`](services/piper/requirements.txt) dokumentiert.

**3. Umgebungsvariablen**

Das Startskript [`scripts/Start-VoiceAssistant.ps1`](scripts/Start-VoiceAssistant.ps1) setzt diese automatisch:

| Variable | Wert | Beschreibung |
|----------|------|--------------|
| `PIPER_VOICES_DIR` | `C:\...\piper\voices` | Verzeichnis mit den `.onnx`-Modellen |
| `PIPER_USE_DIRECTML` | `1` | GPU-Beschleunigung aktivieren (AMD DirectML) |
| `PIPER_DIRECTML_DEVICE` | `0` | GPU-Index (0 = erste GPU) |

#### Server starten

Über das Haupt-Startskript (empfohlen):

```powershell
.\scripts\Start-VoiceAssistant.ps1        # Piper startet minimiert
.\scripts\Start-VoiceAssistant.ps1 -Mode all   # Piper in eigenem Windows Terminal Pane
```

Manuell:

```powershell
cd "C:\Users\$env:USERNAME\Programme\piper-directml-fork"
.\venv\Scripts\Activate.ps1
$env:PIPER_VOICES_DIR      = "C:\Users\$env:USERNAME\Programme\piper\voices"
$env:PIPER_USE_DIRECTML    = "1"
$env:PIPER_DIRECTML_DEVICE = "0"
cd "<Repo-Root>\services\piper"
python -m uvicorn server:app --host 0.0.0.0 --port 5000
```

#### Health-Check & Voice-Discovery

```powershell
# Server-Status + DirectML-Zustand:
& "C:\Windows\System32\curl.exe" http://localhost:5000/health
# Erwartet: {"status":"ok","voices":["emotional","high"],"directml":true}

# Verfügbare Stimmen (Pipecat-kompatible Discovery):
& "C:\Windows\System32\curl.exe" http://localhost:5000/voices
# Erwartet: [{"id":"emotional","name":"...","lang":"de","speakers":8},...]
```

#### TTS-Tests

Die Tests verwenden den **primären Streaming-Endpoint** `/tts/synthesize`.
Für einfaches WAV-Testen (Debug) steht `/synthesize` zusätzlich bereit.

```powershell
# Test 1: Streaming (primärer Produktionspfad) — PCM-Chunks in Datei sammeln
[System.IO.File]::WriteAllText(
    "$env:TEMP\tts-stream.json",
    '{"text":"Hallo Abenteurer, ich bin Rabenauge. Baron Kelthur regiert die Nordprovinz seit zwanzig Jahren.","model":"emotional","speaker_id":4,"length_scale":1.0}',
    [System.Text.UTF8Encoding]::new($false)
)
& "C:\Windows\System32\curl.exe" -X POST http://localhost:5000/tts/synthesize `
    -H "Content-Type: application/json" `
    -d "@$env:TEMP\tts-stream.json" `
    -v 2>&1 | Select-String "X-Sample-Rate|Content-Type|bytes"
# Erwartet: Content-Type: audio/pcm-s16le, X-Sample-Rate: 22050

# Test 2: WAV (Debug, nicht-streaming)
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

# Test 3: Flüsternd (speaker 7)
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

# Test 4: Verlangsamte Sprache (length_scale > 1)
[System.IO.File]::WriteAllText(
    "$env:TEMP\tts-slow.json",
    '{"text":"Baron Kelthur regiert seit zwanzig Jahren die Nordprovinz.","model":"high","length_scale":1.3}',
    [System.Text.UTF8Encoding]::new($false)
)
& "C:\Windows\System32\curl.exe" -X POST http://localhost:5000/synthesize `
    -H "Content-Type: application/json" `
    -d "@$env:TEMP\tts-slow.json" `
    --output test-slow.wav
Start-Process test-slow.wav
```

#### Troubleshooting Piper

| Symptom | Ursache | Lösung |
|---------|---------|--------|
| `No voice models found` | `PIPER_VOICES_DIR` falsch | Env-Var prüfen, Pfad muss `.onnx`-Dateien enthalten |
| `use_directml not supported` | Basis-piper statt Fork | Fork installieren: `pip install -e C:\...\piper-directml-fork` |
| `{"directml":false}` im Health-Check | `PIPER_USE_DIRECTML` nicht gesetzt | Startskript nutzen oder Env-Var manuell setzen |
| Server startet nicht | venv nicht aktiviert | `.\venv\Scripts\Activate.ps1` vor `uvicorn` |

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

Speichern als `scripts/check-services.ps1`, ausführen mit:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-services.ps1
```

---

### Startreihenfolge

```
1. Ollama         → läuft automatisch als Windows-Service beim Boot
2–4. Whisper, Piper, Server → .\scripts\Start-VoiceAssistant.ps1
5. Discord-Bot    → auf Linux: systemctl start discord-bot
```

Das Startskript wartet nach dem Starten von Whisper und Piper auf deren Health-Checks,
bevor der Node-Server hochgefahren wird. Pfade am Anfang des Skripts einmalig anpassen.

---

### Troubleshooting

| Symptom | Ursache | Lösung |
|---------|---------|--------|
| Whisper: `Could not connect` | Server nicht gestartet | `start-whisper.bat` ausführen |
| Whisper: `failed to read audio` | Falsches curl | `C:\Windows\System32\curl.exe` statt `curl` verwenden |
| Ollama: `model not found` | Zweite `ollama serve` Instanz | Terminal-Instanz beenden, nur Service nutzen |
| Ollama: `connection refused` | Service nicht gestartet | Startmenü → Ollama → starten |
| Piper: `connection refused` | FastAPI nicht gestartet | `start-piper.bat` ausführen |
| Piper: `PIPER_EXE not found` | Env-Var nicht gesetzt | Startskript verwenden, oder `$env:PIPER_DIR` manuell setzen |
| Alle Services: Port belegt | Alter Prozess läuft noch | `netstat -ano \| findstr :8080` → PID beenden |

#### Port-Konflikt debuggen

```powershell
netstat -ano | findstr ":8080"
netstat -ano | findstr ":11434"
netstat -ano | findstr ":5000"

# Prozess nach PID beenden (PID aus letzter Spalte):
Stop-Process -Id <PID> -Force
```

## Roadmap

Scope-Klärung abgeschlossen (Mai 2026, siehe „Hauptzweck" und „Operating Modes" oben). Die priorisierte Feature-Reihenfolge mit Aufwand/Impact-Bewertung steht in `~/.claude/plans/schau-in-die-todo-shimmying-phoenix.md`. Backlog/Brainstorm in [`TODO.md`](TODO.md).

**Versionierung**: Bot und Server teilen sich eine Version nach `MAJOR.PHASE.PATCH` — z. B. `1.1.0` für Phase 1, `1.2.0` für Phase 2 usw. Bump erfolgt am Ende einer Phase im Merge-Commit. Im Discord-Bot-Status erscheint `<bot-version>-<git-hash> (server:<server-version>-<git-hash>)`.

**Aktuelle Phasen (grob):**

1. **Phase 1 — Quick Wins** *(in Arbeit)*: Version-Anzeige im Bot-Status, Whisper `temperature=0.2` + `no_speech_prob`-Filter.
2. **Phase 2 — Core Workflows**: `/ask`-Text-Command, Server-Auto-Start via SSH bei `/join`, angereicherter Session-Log.
3. **Phase 3 — Finalize-Pipeline**: `/finalize`-Command, chronologisch korrektes Transkript-Merge mit Monolog-Splitting (Whisper-Token-Timestamps + Per-User-Spuren), OGG/Opus-Audio-Archiv, optional LLM-Summary.
4. **Phase 4 — RAG + Obsidian**: Python-RAG-Service (FastAPI + ChromaDB + Ollama-Embeddings), Vault-Briefing bei `/join`, Vault-Kontext pro Wake-Word-Query.
5. **Phase 5 — Web-UI**: Browser-View für das laufende Transkript mit Auto-Reload (Debugging + Spieler-Begleit-Display).

Die Stränge **Finalize (Phase 3)** und **RAG/Obsidian (Phase 4)** sind voneinander unabhängig und können parallel entwickelt werden.

**Bewusst zurückgestellt / verworfen:**
- `/redact`, `/marker`-Commands — würden LLM-Entscheidungen erfordern; das Transkript bleibt bewusst „raw".
- Multi-Channel-Sessions — Bot ist auf einen Voice-Channel beschränkt.
- Live-Stitching der Monolog-Unterbrechungen — zu komplex; das Live-Log ist chronologisch unkorrigiert, das Finalize-Transkript ist sauber.

---

## Lizenz
UNLICENSED
