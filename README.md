> [!WARNING]
> **Work in progress — persönliches Homelab-Projekt, nicht für den allgemeinen
> Gebrauch.** Dieses Repo ist auf genau *ein* konkretes Setup zugeschnitten
> (Proxmox-LXC als Bot-Host, WireGuard-Tunnel, Verda-Cloud-GPU bzw. ein
> Windows/AMD-Gaming-PC, private Discord-Runde). Pfade, IPs, Modellwahl und
> Deploy-Skripte spiegeln dieses eine Setup wider. Es gibt keinen Support,
> keine Stabilitätsgarantien und scharfe Kanten überall — als Referenz/
> Inspiration gedacht, nicht als installierbares Produkt.

## Titel

Discord Voice Assistant – lokaler Pen-&-Paper-Recorder mit Transkript-Pipeline

## Hauptzweck

Der Bot sitzt während einer Pen-&-Paper-Session **kontinuierlich** im Discord-Voice-Channel und produziert ein **strukturiertes, lokal erzeugtes Transkript** als Eingabe für die Notizen, die die Spieler nebenbei stichpunktartig schreiben. Eine separate Cowork-Pipeline (außerhalb dieses Repos) verarbeitet die fertigen Notizen weiter zu einem Obsidian-Wiki über NPCs, Orte, Quests etc.

Alles läuft **lokal** — auch off-topic / privates Geplauder wird transkribiert, daher kein Cloud-STT/LLM.

**Hauptjob:** zuhören → pro Sprecher mitschneiden → bei `/finalize` ein chronologisch korrektes Transkript erzeugen.
**Nebenfeature:** Wake-Word-Aktivierung („Rabenauge, …") für In-Game-Lookups (NPC-Fragen, Regeln) per lokalem LLM. Antworten werden im Voice-Channel zurückgespielt und im Transkript markiert.

## Komponenten

* **Bot (apps/bot)** — Discord-Recorder. Nimmt pro Sprecher Opus-Frames auf (siehe [recorder.js](apps/bot/src/recorder.js)), speichert lokal als WAV. Sendet im Live-Modus optional Frames an den Server für sofortige Transkription. TTS-Antworten werden über den neuen FIFO-Downlink abgespielt: keine Timestamp-Scheduling-Logik, kein JitterBuffer und keine Stale-Drops im aktiven TTS-Pfad.
* **Server (apps/server)** — STT-/LLM-/TTS-Pipeline (Whisper + Ollama + Piper, alle lokal). Empfängt Uplink-Frames, transkribiert pro Utterance, scannt auf Wake-Word/Stop-Phrases, ruft LLM auf, generiert TTS-Antwort und streamt Opus-Frames per JSON-Downlink an den Bot.
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

### Live-Transkript-Web-UI

Read-only Browser-View des laufenden Transkripts — nützlich zum Debuggen und als Spieler-Begleit-Display. Läuft auf demselben Server-Port wie die übrigen Endpunkte (Default `7440`), keine eigene App, kein Build-Schritt, keine Fremdaufrufe (Roboto ist selbst gehostet).

Aufruf im Browser: `http://<server>:7440/transcript/`

* **Auth**: standardmäßig HTTP-Basic mit `greyhawk` / `greyhawk` (per `TRANSCRIPT_UI_*` änderbar, mit `TRANSCRIPT_UI_AUTH=off` im vertrauten LAN abschaltbar).
* **Live-Update**: primär über Server-Sent Events (`GET /transcript/live`), automatischer Fallback auf Polling (`GET /transcript/snapshot/:id`), wenn SSE wiederholt scheitert.
* **History**: beim Seitenaufruf wird das vollständige Transkript aus dem JSONL-Log rekonstruiert (überlebt Reloads mitten in der Session und das Wegfalten älterer Turns in die rollende Zusammenfassung). Die gefalteten Turns sind als Zusammenfassung einklappbar sichtbar.
* **Session-Auswahl**: ohne `?sessionId=` wird die neueste aktive Session automatisch gewählt. Das Dropdown zeigt standardmäßig nur **aktive** Sessions; die Checkbox **„vergangene"** ergänzt die beendeten Sessions aus dem JSONL-Log. Sessions werden als lesbarer Zeitstempel (`YYYY-MM-DD HH:MM`, abgeleitet aus der Session-ID = Epoch-ms) angezeigt; die Roh-ID bleibt als Tooltip/in der URL.
* **Voice-Status & Teilnehmer**: ein Pill im Header zeigt, ob der Bot im Voice-Channel ist (verbunden / allein / nicht verbunden) — unabhängig von der Datenverbindung (SSE/Polling). Ein Member-Popover im Header listet die aktuell anwesenden Sprecher (live über `presence`-Events).
* **Wake-Word-/Stop-Markierung**: Zeilen, die Rabenauge ausgelöst haben, werden komplett hervorgehoben (gesamter an das LLM gesendeter Text + „→ Rabenauge"-Badge). Stop-Kommandos markieren nur das Stop-Token. Live nachgereicht über `annotation`-Events (Erkennung läuft erst nach dem Append).
* **Darstellung (Blasen-Flow)**: Jede Äußerung ist EINE Sprechblase (Avatar-Initialen + Name + Uhrzeit oben, Text darunter) mit fester Akzentfarbe pro Sprecher (Tint/Border/Glow daraus berechnet, Rabenauge in Teal, Antworten als Markdown). Zeitlich überlappende Äußerungen teilen sich eine Zeile: die dominante Blase (meiste Wörter) bekommt mehr Breite, Rollentausch gleitet per FLIP-Animation mit leichtem Überschwingen. Blockhöhen wachsen weich; Autoscroll zieht exponentiell ans Ende nach (Hochscrollen pausiert ihn, ↓-Button springt zurück). Alle Farben/Zeiten als CSS-Variablen in `style.css`.
* **Wort-für-Wort-Live-Rendering**: Beim Streaming-STT blenden neue Wörter von unscharf nach scharf ein; noch unbestätigte Hypothesen-Wörter sind gedimmt + kursiv und werden beim Bestätigen „fest" (Server-`stableWords`). Korrigiert die Erkennung ein Wort im unbestätigten Schwanz nachträglich, remountet es mit Blur-in; zurückgezogene Wörter verschwimmen hinaus. Ein blinkendes Caret zeigt die laufende Äußerung an.
* **Unterbrecher-Blasen**: Wer einem laufenden Monolog (oder Rabenauges Antwort) dazwischenredet, erscheint als eigene Blase **neben** der unterbrochenen — vertikal verankert an der Wortzeile, an der die Unterbrechung passierte (`floatInto` vom Server: Wort-Zeitstempel bzw. TTS-Wiedergabeposition). Nichts wird geteilt oder verworfen — alle Äußerungen bleiben vollständig protokolliert (JSONL/Finalize unverändert). Wortgenaue **Wake-Word-** (Teal-Glow) und **Stop-Markierung** (rot) direkt im Text.
* **Debug-Modus** (`?debug=1` oder Button): Millisekunden-Zeitstempel, Roh-Chunks mit Split-Tags (natural/forced/stream), STT-Diagnostik-Fußzeile pro Blase (`no_speech_prob`, Dauer, Anker), einklappbarer **Session-Header** aus `session_meta` (Channel, Start, Wake-Word, Stop-Phrases, LLM-/STT-/TTS-Modelle, Versionen, Clock-Offset). Alles aus dem JSONL → funktioniert live und für vergangene Sessions.
* **Settings-Panel (⚙)**: Laufzeit-Konfiguration von Server UND Bot direkt aus der UI. Das Panel ist **vollständig dynamisch**: es rendert ausschließlich den Katalog aus `apps/server/src/configCatalog.js` (Label, Doku, Typ/Widget, Wirkungs-Badge, Persistenz-Status). **Neue Einstellungen entstehen ausschließlich durch einen Katalog-Eintrag** — Beschreibung in den Code, Panel zieht nach (bot-scope-Keys zusätzlich in die `BOT_KEYS`-Whitelist in `apps/bot/src/configOverrides.js`). Änderungen wirken dauerhaft (Override-Layer `config.overrides.json`) oder nur temporär; Bot-Werte werden über den Control-Kanal gepusht und lokal im Bot persistiert. Der Bot meldet nach jedem Connect/Update seine **Ist-Konfiguration** (`config_state`) zurück — das Panel zeigt echte Bot-Werte und markiert Drift zum gespeicherten Wunsch (⏳). **Secrets** (Namens-Blacklist: `TOKEN`/`SECRET`/`BEARER`/`PASS(WORD)`/`API_KEY`/`CREDENTIAL` …) verlassen nie einen Prozess: API liefert nur „gesetzt?", Schreiben ist gesperrt, der Bot-Report enthält sie nur als Boolean.

Endpunkte (alle unter `/transcript`, hinter der Basic-Auth):

| Endpunkt | Zweck |
|---|---|
| `GET /transcript/` | Statische UI (HTML/CSS/JS). |
| `GET /transcript/live?sessionId=<id>` | SSE-Stream: `snapshot` (volle History), dann live `entry` / `presence` / `annotation` / `session_ended`. Ohne `sessionId` → neueste aktive Session. |
| `GET /transcript/snapshot/:id` | JSON-Snapshot der vollen History (Polling-Fallback; funktioniert auch für bereits beendete Sessions direkt aus dem JSONL). |
| `GET /transcript/sessions[?all=1]` | JSON-Liste der aktiven In-RAM-Sessions; mit `?all=1` zusätzlich die vergangenen Sessions aus dem Log-Verzeichnis. |
| `GET/PUT /transcript/config` | Settings-Panel: Katalog + aktuelle Werte (inkl. Bot-Ist-Stand) lesen; Werte setzen/zurücksetzen (persistent oder temporär). |

## Audio-Archiv

* **Während Aufnahme**: hohe Qualität (PCM 48 kHz / 16-bit WAV, ~1 GB/h pro Sprecher) — gibt Whisper bestmögliche Eingabe.
* **Nach Transkription / bei Finalize**: Originale werden zu OGG/Opus 32 kbps zusammengefasst (~430 MB für eine 6-h-Session mit 5 Spielern). 1–6 Monate aufbewahren für Rebuild/Quality-Checks, dann manuell löschen.

## Transport-Architektur (Detail)

Drei Kanäle zwischen Bot und Server:

* `/uplink` (Binär, 20-ms-Frames pro Sprecher; Codec `opus` Passthrough — kein Re-Encode im Bot)
* `/downlink` (JSON, `tts_start` / `tts_frame` / `tts_done`; Opus-Frames base64 im Payload)
* `/control` (WebSocket JSON; Events/Befehle/Backpressure)

**TTS-Playback im Bot**: Der neue Pfad nutzt eine FIFO-Queue ohne Timestamp-Scheduling und ohne Stale-Drops. Playback startet erst mit dem ersten echten `tts_frame`, endet bei `tts_done` und leerer Queue mit `push(null)`. Bei Unterbrechung pausiert der Readable; beim Fortsetzen werden `REWIND_MS` aus der Playback-History erneut eingespielt. Der Bot meldet bei Stop bereits `framesPlayed`/`msPlayed` zurück, damit spätere Transkript-Kürzung möglich ist.

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
SERVER_START_CMD=ssh -i ~/.ssh/id_ed25519_va -o BatchMode=yes -o StrictHostKeyChecking=accept-new nogar@192.168.20.101 "powershell -ExecutionPolicy Bypass -File C:\Users\nogar\Programme\discord-voice-assistant\scripts\Start-VoiceAssistant.ps1 -Mode silent"

UPLINK_CODEC=opus
UPLINK_OPUS_BITRATE=32000

GATE_MS=80
PLAYOUT_MAX_MS=1500
INTERRUPT_MIN_MS=800
RESUME_GATE_MS=1200
REWIND_MS=1000
```

| Variable | Standard | Beschreibung |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot-Token aus [discord.com/developers](https://discord.com/developers). Pflichtfeld. |
| `GUILD_ID` | — | Discord-Server-ID. Rechtsklick auf den Server → „ID kopieren" (Developer Mode nötig). Pflichtfeld. |
| `DATA_DIR` | `/opt/discord-recorder/data` | Verzeichnis für WAV-Chunks, Session-JSON und Mischungen. Wird automatisch angelegt. |
| `DEBUG` | — | Auf `1` setzen für ausführliche Logs (STT-Transkripte, Wake-Word-Ergebnis, LLM-Antworten). |
| `SESSION_IDLE_HOURS` | `4` | Stunden Inaktivität bis zur automatischen Session-Finalisierung beim Serverneustart. |
| `SERVER_BASE_URL` | — | Basis-URL des Servers, z. B. `ws://192.168.20.101:7440`. Bevorzugte Einstellung — überschreibt die Ableitung aus `CONTROL_WS_URL`. |
| `SERVER_START_CMD` | — | Optionaler Startbefehl, den der Bot bei `/join` ausführt, wenn `SERVER_BASE_URL` nicht erreichbar ist. Getestet mit SSH auf den Windows-Server und `Start-VoiceAssistant.ps1 -Mode silent`. |
| `UPLINK_PROTO` | `ws` | Protokoll für den Uplink-WebSocket. `ws` für LAN, `wss` für TLS. |
| `UPLINK_HOST` | — | IP-Adresse oder Hostname des Servers. Nur nötig wenn `SERVER_BASE_URL` nicht gesetzt. |
| `UPLINK_PORT` | — | TCP-Port des Servers (z. B. `7440`). Nur nötig wenn `SERVER_BASE_URL` nicht gesetzt. |
| `UPLINK_CODEC` | `opus` | Codec für Uplink-Frames. `opus` empfohlen (kein Re-Encode im Bot). `pcm` sendet rohe 16-bit PCM-Daten. |
| `UPLINK_OPUS_BITRATE` | `32000` | Opus-Bitrate in bps für den Uplink. 32000 ist ein guter Kompromiss für Sprache. |
| `DOWNLINK_WS_URL` | — | Direkte WebSocket-URL für den Downlink-Kanal. Veraltet — `SERVER_BASE_URL` verwenden. |
| `CONTROL_WS_URL` | — | Direkte WebSocket-URL für die Control-Plane, z. B. `ws://192.168.20.101:7440/control`. Veraltet — `SERVER_BASE_URL` verwenden. |
| `CONTROL_BEARER` | — | Bearer-Token zur Authentifizierung gegenüber dem Server. Muss mit dem Server-`CONTROL_BEARER` übereinstimmen. |
| `GATE_MS` | `80` | Legacy/derzeit ungenutzt im neuen FIFO-TTS-Pfad. |
| `PLAYOUT_MAX_MS` | `1500` | Legacy/derzeit ungenutzt im neuen FIFO-TTS-Pfad. |
| `INTERRUPT_MIN_MS` | `800` | Mindest-Sprechdauer in ms, ab der eine Aussage als echte Unterbrechung gewertet wird. Kürzere Geräusche (Husten, Lachen, Hintergrundgeräusche) werden ignoriert. |
| `RESUME_GATE_MS` | `1200` | Stille-Dauer in ms nach dem Ende einer Unterbrechung, bevor die Wiedergabe fortgesetzt wird. Wird bei erneuter User-Sprache während Pause neu gestartet. |
| `REWIND_MS` | `1000` | Beim Fortsetzen nach einer Unterbrechung werden so viele Millisekunden aus der Playback-History erneut vor die Queue gelegt. |

Für den Mention-Trigger `@Botname Frage` muss im Discord Developer Portal der privilegierte **Message Content Intent** für den Bot aktiviert sein. Der Slash-Command `/ask` funktioniert unabhängig davon.

### Server – `apps/server/.env`

```env
HOST=0.0.0.0
PORT=7440
CONTROL_BEARER=changeme
SESSION_SECRET=
DEBUG=1

WHISPER_URL=http://localhost:8080
WHISPER_LANGUAGE=de
WHISPER_TEMPERATURE=0.1
# no_speech_prob wird gespeichert, aber im Live-Pfad nicht verworfen.
# Optionaler Zukunftswert fuer Finalize/offline-Filtertests:
# WHISPER_NO_SPEECH_THRESHOLD=0.67
STT_MAX_CHUNK_SECONDS=30
STT_SILENCE_THRESH=300

OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
SYSTEM_PROMPT_FILE=./prompt.txt
HISTORY_TURNS=6

LIVE_CONTEXT_ENABLED=true
LIVE_RAW_WINDOW_CHARS=6000
LIVE_FOLD_CHARS=3000
LIVE_RENDER_MAX_CHARS=6000
# SUMMARY_MODEL=
SUMMARY_MAX_CHARS=2000
# OBSIDIAN_VAULT_PATH=/pfad/zum/vault
CAMPAIGN_CONTEXT_FILE=CAMPAIGN.md
CAMPAIGN_CONTEXT_MAX_CHARS=6000

TTS_PROVIDER=piper
TTS_URL=http://localhost:5000

WAKE_WORD=Rabenauge
WAKE_WORD_FUZZY=true
WAKE_WORD_POSITION=3
STOP_PHRASES=stop,stopp,abbrechen,beenden,hör auf,aufhören,halt,halte an,halte ein
STOP_WITHOUT_WAKE_MAX_WORDS=5
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
| `WHISPER_TEMPERATURE` | `0.2` | Sampling-Temperature für Whisper. Lokale `.env.example` nutzt konservativ `0.1`; Werte >0 liefern brauchbarere `no_speech_prob`-Werte als deterministisches `0`. |
| `WHISPER_NO_SPEECH_THRESHOLD` | — | Der Live-Pfad verwirft aktuell nichts anhand von `no_speech_prob`; die Werte werden im JSONL gespeichert. Ein Threshold ist nur als späterer Finalize-/Offline-Filter vorgesehen. |
| `STT_MAX_CHUNK_SECONDS` | `30` | Maximale Länge eines STT-Chunks im **Fallback-/Finalize-Pfad** (der Live-Pfad streamt ohne Chunk-Grenzen, s. u.). Längere Utterances werden an Stille geteilt; ohne passende Stille wird mit `OVERLAP=2s` forced gesplittet — die Overlap-Dopplung wird zeitbasiert über Wort-Zeitstempel entfernt. |
| `STT_SILENCE_THRESH` | `300` | RMS-Schwellwert für Silence-Detection beim Aufteilen langer Utterances (Fallback-/Finalize-Pfad). Frames mit RMS < Schwellwert gelten als Stille. Muss ggf. je nach Mikrofon und Raumakustik angepasst werden — siehe Hinweis unten. |

#### Streaming-STT (Live-Transkription während des Sprechens)

Der Live-Pfad transkribiert **ohne Chunk-Grenzen**: Das wachsende Audio-Fenster eines Sprechers wird jede Sekunde als Ganzes an whisper.cpp geschickt (voller Kontext, nie mitten im Wort geschnitten). Wörter, in denen zwei aufeinanderfolgende Hypothesen übereinstimmen, werden **bestätigt** (LocalAgreement-2) und erscheinen sofort im Live-Transkript; der Satzrest wird als noch korrigierbare Vorschau gedimmt angezeigt. Sobald die bestätigten Wörter `STT_STREAM_TRIM_SECONDS` Audio abdecken, wird das Fenster an der letzten bestätigten Satzgrenze **fixiert** und abgeschnitten — die GPU-Last pro Tick bleibt dadurch unabhängig von der Monolog-Länge (Fenster ≤ ~25 s). Am Äußerungsende wird nur noch das Restfenster einmal final transkribiert (statt der kompletten Äußerung); bestätigte Wörter werden dabei nie zurückgenommen.

| Variable | Standard | Beschreibung |
|---|---|---|
| `STT_STREAMING` | `true` | Streaming-Transkription ein/aus. Aus = altes Verhalten (Transkript erst am Äußerungsende, Chunk-Pfad). |
| `STT_STREAM_INTERVAL_MS` | `1000` | Tick-Intervall des Streaming-Loops. Kleiner = reaktiver, mehr GPU-Last (Neustart nötig). |
| `STT_STREAM_MIN_WINDOW_MS` | `1000` | Mindest-Audio, bevor der Streamer das erste Mal transkribiert (sehr kurze Fenster liefern unbrauchbare Hypothesen). |
| `STT_STREAM_TRIM_SECONDS` | `15` | Ab so vielen Sekunden bestätigten Audios wird das Fenster an der letzten Satzgrenze fixiert. |
| `STT_STREAM_PROMPT` | `true` | Fixierten Text als Whisper-Decoder-Prompt mitgeben (konsistente Erkennung über die Fenstergrenze). |

> **GPU-Portabilität (AMD heute, NVIDIA/Cloud später):** Der Server spricht nur die whisper.cpp-HTTP-API (`WHISPER_URL`). whisper.cpp gibt es mit identischer API als **Vulkan**-Build (AMD, aktuelles Setup) und als **CUDA/cuBLAS**-Build (NVIDIA, z. B. Cloud-Instanz mit H100) — beim Umzug wechselt nur das Binary bzw. die URL, am Server-Code ändert sich nichts. Gemessen auf der RX 6800 XT (Vulkan, medium-q5_0, warm): 10 s Audio ≈ 0,6 s, 30 s ≈ 1,8 s (16–24× Echtzeit) — genug Headroom für den 1-s-Tick.

**End-to-End-Test:** `node tests/ui-sim.mjs` startet den Server auf Port 7441 (Auth aus) und speist `tests/Quantengravitation.m4a` (86 s vorgelesener Wikipedia-Text, Ground-Truth in `tests/transcript.txt`) in Echtzeit als Fake-Sprecher ein — das Wort-für-Wort-Streaming lässt sich unter `http://127.0.0.1:7441/transcript/?sessionId=1780000000001` live ansehen. Voraussetzung: whisper.cpp-Server auf `:8080` läuft, `ffmpeg` im PATH.

#### LLM

| Variable | Standard | Beschreibung |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | URL des Ollama-Servers. |
| `OLLAMA_MODEL` | `llama3` | Zu verwendendes Ollama-Modell. Muss zuvor mit `ollama pull <modell>` geladen worden sein (z. B. `llama3.2`). |
| `SYSTEM_PROMPT_FILE` | — | Pfad zu einer UTF-8-Textdatei mit dem System-Prompt, z. B. `./prompt.txt`. **Empfohlen** — kein Escaping nötig, da Dateiinhalt direkt gelesen wird. Relativ zum Arbeitsverzeichnis beim Serverstart (`apps/server/`). Hat Vorrang vor `SYSTEM_PROMPT`. |
| `SYSTEM_PROMPT` | *(eingebaut)* | System-Prompt als Inline-String in der `.env`. Fallback wenn `SYSTEM_PROMPT_FILE` nicht gesetzt. Bei komplexen Prompts mit Anführungszeichen oder JSON-Syntax schwer zu escapen — `SYSTEM_PROMPT_FILE` bevorzugen. |
| `HISTORY_TURNS` | `6` | Anzahl der Gesprächs-Runden (User+Assistant je = 1 Turn), die als Kontext an Ollama übergeben werden. Höhere Werte = besserer Kontext, aber mehr Token-Verbrauch. |
| `OLLAMA_KEEP_ALIVE` | `30m` | Wie lange Ollama das Modell nach einer Anfrage im VRAM hält. Wird bei jeder Chat-Anfrage und beim Keep-Warm gesetzt, damit das Modell zwischen Wake-Word-Queries nicht entladen wird. `-1` = dauerhaft geladen, `0` = sofort entladen. |
| `OLLAMA_KEEP_WARM_INTERVAL_MS` | `240000` | Intervall (ms) für periodische Keep-Warm-Pings, solange der Bot im Voice-Channel ist. Hält das Modell auch in langen Gesprächspausen warm. `0` oder negativ deaktiviert die periodischen Pings (das `keep_alive` jeder echten Query wirkt weiterhin). |

#### Live-Kontext & Kampagnen-Kontext

Das Live-Transkript der laufenden Runde (alle Sprecher, nicht nur Wake-Word-Anfragen) wird im RAM gepuffert und dem LLM bei jeder Anfrage als zusätzliche `system`-Blöcke übergeben: Kampagnen-Kontext → laufende Zusammenfassung → Live-Transkript. Ältere Turns werden bei Überlauf asynchron in eine rollende Zusammenfassung gefaltet. Bei (Re-)Start wird der Puffer aus dem JSONL-Log rekonstruiert.

| Variable | Standard | Beschreibung |
|---|---|---|
| `LIVE_CONTEXT_ENABLED` | `true` | Schaltet Live-Transkript, rollende Zusammenfassung und Kampagnen-Kontext gemeinsam ein/aus. Auf `false` verhält sich der Server wie zuvor (nur `HISTORY_TURNS`-Verlauf). |
| `LIVE_RAW_WINDOW_CHARS` | `6000` | Zielgröße (Zeichen) des rohen Live-Puffers. Wird sie überschritten, werden die ältesten Turns in die Zusammenfassung gefaltet. |
| `LIVE_FOLD_CHARS` | `3000` | Wie viele Zeichen pro Faltung (vom ältesten Ende) in die Zusammenfassung wandern. |
| `LIVE_RENDER_MAX_CHARS` | `6000` | Obergrenze der Zeichen, die das Live-Transkript im Prompt belegt (neueste Zeilen bevorzugt). |
| `LIVE_FOLD_MIN_INTERVAL_MS` | `0` | Mindestabstand zwischen zwei Faltungen (Drosselung). `0` = keine Drosselung. |
| `SUMMARY_MODEL` | *(= `OLLAMA_MODEL`)* | Optionales separates Ollama-Modell für die Zusammenfassung. Leer = dasselbe Modell wie für Antworten. |
| `SUMMARY_MAX_CHARS` | `2000` | Maximale Länge der rollenden Zusammenfassung. |
| `OBSIDIAN_VAULT_PATH` | — | Wurzelverzeichnis des Obsidian-Vaults. Nötig, wenn `CAMPAIGN_CONTEXT_FILE` ein relativer Pfad ist. |
| `CAMPAIGN_CONTEXT_FILE` | `CAMPAIGN.md` | Datei mit dem statischen Kampagnen-Kontext (Variante A — Fallback, wenn `RAG_URL` nicht gesetzt oder der RAG-Dienst nicht erreichbar ist). Absoluter Pfad oder relativ zu `OBSIDIAN_VAULT_PATH`. Relativ ohne gesetztes Vault → Datei-Fallback deaktiviert. Wird mit mtime-Check gecacht, Edits greifen ohne Neustart. |
| `CAMPAIGN_CONTEXT_MAX_CHARS` | `6000` | Obergrenze der Zeichen des Kampagnen-Kontexts (vom Anfang der Datei, die wichtigste Information zuerst). Gilt auch für RAG-Treffer und den Vault-Kontext des `/join`-Briefings. |

#### RAG (semantische Vault-Suche, Phase 4)

Der Python-RAG-Dienst (`apps/rag/`) indiziert den Obsidian-Vault und liefert pro Wake-Word-Query die relevantesten Chunks. Bei gesetztem `RAG_URL` ersetzt die semantische Suche das statische `CAMPAIGN.md`; ist der Dienst aus/nicht erreichbar, degradiert der Server lautlos auf die Datei.

| Variable | Standard | Beschreibung |
|---|---|---|
| `RAG_URL` | — | Basis-URL des RAG-Dienstes (z. B. `http://localhost:5001`). Leer = RAG aus, nur `CAMPAIGN.md`. |
| `RAG_TIMEOUT_MS` | `800` | Timeout pro RAG-Abfrage (Verbindung + Antwort); danach Fallback auf die Datei — die Wake-Word-Pipeline wartet höchstens so lange. Das `/join`-Briefing bekommt mindestens 5000 ms. |
| `RAG_SCORE_THRESHOLD` | — | Maximale Cosine-Distanz (0–2, kleiner = ähnlicher) eines Treffers; wird als `score_threshold` an `POST /query` durchgereicht. Leer = kein Filter. Treffer werden wie `CAMPAIGN.md` auf `CAMPAIGN_CONTEXT_MAX_CHARS` gekappt. |
| `RAG_BRIEFING_ENABLED` | `true` | Vault-Briefing beim `/join` (einmal pro Session): RAG-Query mit der aus dem JSONL dieser Session rekonstruierten Zusammenfassung → Vault-Kontext als `role:system`-Message am Anfang der History. Greift nur beim Fortsetzen einer Session mit schon zusammengefasstem Verlauf (z. B. nach Server-Neustart); eine neue Session hat noch kein Summary. Nur wirksam bei gesetztem `RAG_URL`. |
| `RAG_BRIEFING_TOP_K` | `3` | Anzahl der Vault-Chunks fürs Briefing (1–20). |
| `RAG_BRIEFING_POST_CHAT` | `false` | Briefing zusätzlich als kurze Discord-Textnachricht posten (einmal pro Session, nicht bei jedem Reconnect). `false` = nur als LLM-Kontext injizieren. |

#### TTS (Text-to-Speech)

| Variable | Standard | Beschreibung |
|---|---|---|
| `TTS_PROVIDER` | `piper` | TTS-Backend: `piper` für lokalen Piper/KokoroTTS-Server, `elevenlabs` für die ElevenLabs-Cloud-API. |
| `TTS_URL` | `http://localhost:5000` | URL des lokalen TTS-Servers (nur bei `TTS_PROVIDER=piper`). Erwartet `POST /tts/synthesize` mit JSON `{text, model, speaker_id, length_scale, noise_scale, noise_w_scale}` → chunked `audio/pcm-s16le`. |
| `ELEVENLABS_API_KEY` | — | API-Key für ElevenLabs (nur bei `TTS_PROVIDER=elevenlabs`). |
| `ELEVENLABS_VOICE_ID` | `EXAVITQu4vr4xnSDxMaL` | Voice-ID für ElevenLabs. Standard ist eine englische Männerstimme; für Deutsch eine passende Stimme aus dem ElevenLabs-Katalog wählen. |

#### Wake-Word

| Variable | Standard | Beschreibung |
|---|---|---|
| `WAKE_WORD` | `Rabenauge` | Aktivierungswort. Der Bot verarbeitet eine Aussage nur, wenn dieses Wort erkannt wird. Groß-/Kleinschreibung wird ignoriert. |
| `WAKE_WORD_FUZZY` | `true` | Fuzzy-Matching mit Levenshtein-Distanz ≤ 2. Erkennt Vertipper und Aussprache-Varianten (z. B. „Rabenaugen", „Rabenoge"). Auf `false` setzen für exaktes Matching. |
| `WAKE_WORD_POSITION` | `3` | Maximale Wortposition des Wake-Words im Transkript. `3` = Wake-Word muss in den ersten 3 Wörtern stehen. `0` = überall im Satz erlaubt. Verhindert False-Positives wenn das Wake-Word mitten in einer Aussage vorkommt. |
| `STOP_PHRASES` | `stop,stopp,abbrechen,beenden,hör auf,aufhören,halt,halte an,halte ein` | Kommagetrennte Liste erkannter Stop-Phrasen. Mit Wake-Word wird nur der Text nach dem Wake-Word geprüft; ohne Wake-Word nur kurze Äußerungen bis `STOP_WITHOUT_WAKE_MAX_WORDS`. |
| `STOP_WITHOUT_WAKE_MAX_WORDS` | `5` | Maximale Wortzahl für Stop-Phrases ohne Wake-Word. Verhindert, dass normale Sätze mit Stop-Wörtern versehentlich die Wiedergabe abbrechen. |

> **Silence-Detection kalibrieren**: Die Silence-Erkennung (`STT_SILENCE_THRESH`) muss möglicherweise je nach Mikrofon und Raumakustik angepasst werden. Bei langen Aufnahmen (`> STT_MAX_CHUNK_SECONDS`) loggt der Server mit `DEBUG=1` Details wie Gesamtdauer, Threshold, Chunk-Anzahl, Chunk-Dauern und Split-Typ (`natural-silence`, `forced-overlap`, `tail`). Erscheint bei langen Fragen kein sinnvoller Natural-Split, ist der Schwellwert oft zu niedrig (zu viel Hintergrundrauschen wird als Sprache gewertet) → `STT_SILENCE_THRESH` erhöhen (z. B. auf `500`–`800`).

#### Live-Transkript-Web-UI

Read-only Browser-View unter `http://<server>:<PORT>/transcript/` (siehe [Live-Transkript-Web-UI](#live-transkript-web-ui)).

| Variable | Standard | Beschreibung |
|---|---|---|
| `TRANSCRIPT_UI_AUTH` | `basic` | `basic` = HTTP-Basic-Auth erforderlich. `off` (auch `none`/`false`/`0`) = ohne Auth erreichbar (nur für vertrautes LAN). |
| `TRANSCRIPT_UI_USER` | `greyhawk` | Benutzername für die Basic-Auth. |
| `TRANSCRIPT_UI_PASS` | `greyhawk` | Passwort für die Basic-Auth. |

> Die UI nutzt denselben `PORT` wie der übrige Server und liest den vollständigen Verlauf aus `TRANSCRIPT_DIR` (siehe [Live-JSONL-Events](#live-jsonl-events)). Die rollende Zusammenfassung stammt aus dem RAM und ist nur für aktive Sessions verfügbar.

### Live-JSONL-Events

Während Online-Live schreibt der Server rohe Events nach `TRANSCRIPT_DIR` (Default `./transcripts`) in `session_<sessionId>.jsonl`. Jede Zeile ist ein eigenständiges JSON-Objekt mit gemeinsamen Feldern:

```json
{"tsMs":1778600001000,"type":"user_transcript","sessionId":"1778422813219"}
```

`tsMs` ist ein absoluter Unix-Zeitstempel in Millisekunden und gilt für alle Event-Typen. Zusätzliche relative Zeitfelder werden bewusst vermieden, solange eine absolute Zeitangabe reicht.

#### Schema v1

* `session_meta` — einmal pro Session, direkt nach `session_start`. Enthält statische Session-Konfiguration: Discord-Guild/Channel, Bot-/Server-Version, LLM-/STT-/TTS-Konfiguration, Wake-Word, Stop-Phrases und ein vorbereitetes `users`-Objekt. Dieses Event macht spätere Finalize-/RAG-Schritte reproduzierbar, auch wenn `.env` oder Prompts später geändert wurden.
* `user_transcript` — eine Zeile pro abgeschlossener User-Audioaufnahme nach erfolgreichem STT-Aufruf. Enthält `userId`, `userDisplayName`, `startTsMs`, `endTsMs`, `durationMs`, `text`, `chunks` und `stt`. Wenn Whisper leeren Text liefert, bleibt `text` leer, aber die STT-Diagnostik wird gespeichert. Ein separates `utterance_end`-Event wird nicht ins JSONL geschrieben, damit das Transkript nicht mit Transportereignissen verstopft.
* `text_query` — Textfrage aus `/ask` oder Mention-Trigger. Der Mention-Trigger benötigt in Discord den Message-Content-Intent.
* `wakeword_query` — erkannter Wake-Word-Trigger und extrahierte Query.
* `assistant_response` — rohe LLM-Antwort inklusive `turnId`, Text und Voice-Metadaten.
* `tts_start`, `tts_done`, `tts_cancel`, `tts_error` — TTS-Lifecycle. `turnId` verbindet Assistant-Antwort und TTS-Ausgabe.
* `playback_paused`, `playback_resumed` — kompakte Bot-Playback-Events bei User-Unterbrechung. Enthalten u. a. `id`, `framesPlayed`, `msPlayed`, Queue-/Duration-Werte, Unterbrecher-User, Pause-Dauer und Rewind-Info. Sie sind strukturiert, damit später sichtbar ist, wo User-Audio in Bot-Audio fiel, ohne den normalen Textfluss künstlich aufzublähen.
* `stop_command` — erkannte Stop-Phrase. Stop-Phrases funktionieren ohne Wake-Word nur bei kurzen Äußerungen bis `STOP_WITHOUT_WAKE_MAX_WORDS`; mit Wake-Word wird die Stop-Phrase nicht als neue LLM-Anfrage weitergereicht.
* `playback_stopped` — Bot-Feedback mit `framesPlayed` und `msPlayed` nach Stop.
* `assistant_response_played` — bei Stop geschätzter tatsächlich gehörter Antworttext, bei Bedarf mit `...` gekürzt.

`stt.noSpeechProbAvg` und `stt.noSpeechProbMax` werden gespeichert, aber im Live-Pfad nicht zum Verwerfen genutzt. Auch wahrscheinlich verrauschte Transkripte bleiben damit für spätere Filtertests und Finalize-Entscheidungen nachvollziehbar.

Das vorbereitete `users`-Objekt in `session_meta` ist absichtlich leer. Es reserviert das Format für eine spätere konfigurierbare Zuordnung `Discord-User-ID -> Discord-Name / Spielername / Charaktername / phonetischer Name`, ohne jetzt schon eine feste Mapping-Datei zu erzwingen.

Die gekürzte Assistant-Antwort wird heuristisch berechnet (`msPlayed / durationMs`) und am nächsten folgenden Whitespace geschnitten. Wenn weniger als 15 Zeichen oder weniger als 5 % Rest übrig bleiben, wird nicht gekürzt.

Beispielhafte Zeilen:

```jsonl
{"tsMs":1778600000000,"type":"session_meta","sessionId":"1778422813219","schemaVersion":1,"guildName":"Jn","channelName":"Session","llm":{"provider":"ollama","model":"llama3.2","historyTurns":6},"stt":{"provider":"whisper.cpp","language":"de","temperature":0.1,"noSpeechProbStored":true,"noSpeechProbFiltersLive":false,"maxChunkSeconds":30,"silenceThresh":300},"wakeword":{"word":"Rabenauge","fuzzy":true,"position":3},"stopPhrases":["stop","stopp"],"users":{}}
{"tsMs":1778600004123,"type":"user_transcript","sessionId":"1778422813219","userId":"696665320185659453","userDisplayName":"Nogâr","startTsMs":1778600001000,"endTsMs":1778600003900,"durationMs":2900,"text":"Hey Rabenauge, wer ist Baron Kelthur?","chunks":["Hey Rabenauge, wer ist Baron Kelthur?"],"stt":{"provider":"whisper.cpp","noSpeechProbAvg":0.03,"noSpeechProbMax":0.05,"chunkDurationsMs":[2900],"splitTypes":["single"]}}
{"tsMs":1778600004300,"type":"assistant_response","sessionId":"1778422813219","turnId":"turn-...","text":"Baron Kelthur ist ein Halbork-Söldner.","speakerId":4,"model":"high"}
{"tsMs":1778600006000,"type":"playback_paused","sessionId":"1778422813219","id":"tts-...","framesPlayed":80,"msPlayed":1600,"interruptedByUserId":"696665320185659453","interruptMinMs":800,"rewindMs":1000}
{"tsMs":1778600008500,"type":"playback_resumed","sessionId":"1778422813219","id":"tts-...","framesPlayed":80,"msPlayed":1600,"pauseDurationMs":2500,"resumeGateMs":1200,"rewindFrames":50,"rewoundMs":1000}
```

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

* In Discord in den Voice-Channel, **/join** → Aufnahme startet (per-Speaker
  WAV-Chunks + `session.json`-Timeline unter `DATA_DIR/<id>/`).
* **/leave** verlässt den Channel — die Session bleibt **offen** und kann später
  fortgesetzt (`/join`) oder abgeschlossen werden.
* **/finalize run** schließt die Session ab → der Server transkribiert die WAVs
  neu, baut ein chronologisches Markdown-Transkript (`transcript.md`) und ein
  OGG/Opus-Audio-Archiv. Ohne laufenden Server ist Finalize nicht möglich
  (STT + Transkript-Erzeugung liegen serverseitig).
* **/finalize list** / **/finalize show \<id\>** — Sessions auflisten / Details.
* **/finalize map user:@… player:… [character:… phonetic:…]** — Sprecher-Zuordnung.
* Inaktive Sessions werden vom Server **automatisch finalisiert** (Idle-Timer,
  Standard 4 h, sobald der Bot allein im Channel ist oder nach `/leave`).

### Offline-Transkript aus einem JSONL-Log

```bash
npm run transcript -- apps/server/transcripts/session_<id>.jsonl --tz Europe/Berlin
```

Siehe `docs/phase-3-manual-tests.md` für die vollständige manuelle Test-Checkliste.

## Nutzung (mit Server, on-demand)

* Server starten (Windows).
* Bot verbindet optional `/uplink` (per-Speaker), `/downlink` (Abo), `/control`.
* Test: `/control` → `{"type":"play_test_tone","sessionId":"<id>"}` sendet 20-ms-Opus-Frames über den JSON-Downlink an den Bot.
* Wake-Word sprechen: *„Rabenauge, wer ist Baron Kelthur?"* → Bot antwortet per Sprache im Voice-Channel.
* Textfrage ohne Vorlesen: `/ask frage:Wer ist Baron Kelthur?` oder `@Botname Wer ist Baron Kelthur?`.
* Textfrage mit Voice-Ausgabe: `/ask frage:Wer ist Baron Kelthur? tts:true`. Der Textpfad nutzt dieselbe LLM-/History-Pipeline wie Wake-Word-Anfragen, überspringt aber STT/Wake-Word-Erkennung.

Nach Änderungen an Slash-Commands muss der Bot neu registriert werden:

```bash
npm run register
```

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
| RAG | 5001 | Vault-Suche (optional) | FastAPI + ChromaDB + Ollama-Embeddings |

Whisper, Ollama und Piper müssen laufen bevor der Discord-Server gestartet wird; der RAG-Dienst ist optional (Server degradiert ohne ihn auf `CAMPAIGN.md`).

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

## Manuelle Test-Checkliste

Nach größeren Pipeline-Änderungen (TTS-Rework, Session-Log, `/ask`-Pfad …) in dieser
Reihenfolge durchgehen. Discord-Tests setzen einen laufenden Bot + Server voraus.

### Voice Pipeline
- [ ] `/join` → Bot tritt Channel bei, Server-Auto-Start via SSH funktioniert (falls `SERVER_START_CMD` gesetzt)
- [ ] Bot-Status zeigt `<bot-version>-<hash> (server:<server-version>-<hash>)` sobald Server verbunden
- [ ] Server offline + kein Auto-Start → Status bleibt ohne `(server:…)`-Teil
- [ ] Wake-Word („Rabenauge, …") → Bot antwortet per TTS im Voice-Channel
- [ ] Wake-Word + jemand unterbricht → TTS pausiert, setzt nach `RESUME_GATE_MS` mit `REWIND_MS` fort
- [ ] Stop-Phrase während TTS → Wiedergabe bricht sofort ab
- [ ] Stop-Phrase ohne Wake-Word (innerhalb `STOP_WITHOUT_WAKE_MAX_WORDS`) → TTS bricht ab
- [ ] `/leave` → Bot verlässt Channel, Status wird zurückgesetzt

### Text Pipeline (`/ask` + `@Bot`)
- [ ] `/ask frage:"…"` → Antwort als Text im Channel
- [ ] `/ask … tts:true` während aktiver Voice-Session → Antwort als Text **und** im Voice-Channel vorgelesen
- [ ] `/ask … tts:true` ohne Voice-Session → nur Text, kein TTS
- [ ] `@Bot Frage` → selbes Verhalten wie `/ask` ohne TTS
- [ ] **History-Scoping (siehe `_activeVoiceChannelId`-Logik):**
  - [ ] `/ask` im **Text-Chat des Voice-Channels** während aktiver Session → Bot kennt Wake-Word-Kontext (gleiche History)
  - [ ] `/ask` in **anderem Text-Channel** → eigene channel-scoped History (kein Voice-Kontext)
  - [ ] `/ask` in **Channel A**, dann in **Channel B** → Folgefrage in B kennt A nicht
  - [ ] Normale Chat-Nachrichten ohne `@Bot` werden **ignoriert** (kein Lauschen)

### STT / Whisper
- [ ] Kurze Aussage (<3 s) → korrekt transkribiert, kein Split
- [ ] Lange Aussage (>30 s) → wird gesplittet, im Log: `pipeline: Xs → N silence-split chunks` (bei `DEBUG=1`)
- [ ] Stille / Atemgeräusch ohne Sprache → leeres Transkript, `noSpeechProbAvg/Max` im JSONL geloggt
- [ ] `WHISPER_TEMPERATURE` aus `.env` wird im Request verwendet

### TTS / Piper
- [ ] `GET /voices` liefert Pipecat-konforme Liste
- [ ] `POST /tts/synthesize` mit `model:emotional` + `speaker_id:0..7` → korrekte Stimme/Emotion
- [ ] `POST /tts/synthesize` mit `model:high` → klare Standardstimme
- [ ] Streaming-Pfad: erste PCM-Chunks treffen ein bevor der ganze Satz fertig ist (`Content-Type: audio/pcm-s16le`)
- [ ] Wiedergabe im Bot startet ohne CNG-Burst (keine Rauschspitze am Anfang)

### Session-Log (JSONL Schema v1)
- [ ] Beim `/join` wird genau ein `session_meta` geschrieben: Discord-Kontext, Bot- + Server-Version, LLM/STT/TTS-Config, Wake-Word, Stop-Phrases, `users`-Mapping
- [ ] `user_transcript` enthält `startTsMs`, `endTsMs`, `durationMs`, STT-Chunks, `noSpeechProbAvg/Max`
- [ ] `assistant_response` enthält `turnId`, `query`, `text`, `speakerId`, `model`, `source` (`voice` / `slash` / `mention`)
- [ ] `text_query`- und `stop_command`-Events werden geloggt

### Auto-Tests (Vitest / `node --test`, optional zu ergänzen)
Diese Funktionen haben keine Discord-/Netz-Abhängigkeiten und eignen sich für Unit-Tests:
- `apps/bot/src/version.js` — `getVersion()`, `makeStatusText()`
- `apps/server/src/pipeline.js` — `sessionlessHistory()` Scope-Isolation, `appendHistory()` Trim-Verhalten
- `apps/server/src/stt.js` — Silence-Split mit Mock-PCM
- (sobald implementiert) `no_speech_prob`-Filter-Schwelle

## Roadmap

Scope-Klärung abgeschlossen (Mai 2026, siehe „Hauptzweck" und „Operating Modes" oben). Die priorisierte Feature-Reihenfolge mit Aufwand/Impact-Bewertung steht in `~/.claude/plans/schau-in-die-todo-shimmying-phoenix.md`. Backlog/Brainstorm in [`TODO.md`](TODO.md).

**Versionierung**: Bot und Server teilen sich eine Version nach `MAJOR.PHASE.PATCH` — z. B. `1.1.0` für Phase 1, `1.2.0` für Phase 2 usw. Bump erfolgt am Ende einer Phase im Merge-Commit. Im Discord-Bot-Status erscheint `<bot-version>-<git-hash> (server:<server-version>-<git-hash>)`.

**Aktuelle Phasen (grob):**

1. **Phase 1 — Quick Wins** *(in Arbeit)*: Version-Anzeige im Bot-Status, Whisper `temperature=0.2` + `no_speech_prob`-Diagnostik.
2. **Phase 2 — Core Workflows** *(implementiert, Praxistest ausstehend)*: `/ask`-Text-Command, Server-Auto-Start via SSH bei `/join`, angereicherter Session-Log mit Schema-v1-Struktur.
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
