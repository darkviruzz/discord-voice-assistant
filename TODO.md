# TODO & Ideen

Backlog/Brainstorm. Aktueller Plan und Live-Test-Checkliste: [`docs/plans/next.md`](docs/plans/next.md) (erledigte Pläne: `docs/plans/archive/`, Betriebswissen: [`docs/ops-notes.md`](docs/ops-notes.md)). Mental Model und Operating Modes: siehe [`README.md`](README.md).

> **Versionierung**: Bot + Server teilen `MAJOR.PHASE.PATCH` (z. B. `1.1.0` = nach Phase 1). Bump am Ende jeder Phase.

---

## Performance / Stabilität

- [x] **LLM-Keep-Warm bei `/join`, Deaktivierung bei `/leave`** (1.4.1) — verhindert, dass das Ollama-Modell während ruhiger Phasen aus dem VRAM entladen wird und die nächste Wake-Word-Query mehrere Sekunden auf den Cold-Load wartet.
  - `apps/server/src/keepWarm.js`: `startKeepWarm()` feuert beim `voice_state: joined/occupied` einen sofortigen Warm-Up und danach periodische Pings; `stopKeepWarm()` stoppt sie beim `left/alone`
  - `apps/server/src/llm.js`: neue `warmUp()`-Funktion (leerer `/api/chat`-Call lädt das Modell); `keep_alive` wird zusätzlich an jede echte Chat-Anfrage gehängt
  - Hook im `voice_state`-Handler in `apps/server/src/control.js`
  - Konfigurierbar via `OLLAMA_KEEP_ALIVE` (Standard `30m`) und `OLLAMA_KEEP_WARM_INTERVAL_MS` (Standard `240000`)
  - Offen für später: Warm-Up auch beim Server-Start (vor erstem `/join`), Latenz-Messung Warm vs. Cold im DEBUG-Log

- [ ] **Claude Haiku API als optionaler LLM-Provider** — Vergleichstest gegen lokales Ollama.
  - API-Key-Setup (`ANTHROPIC_API_KEY` in `.env`), Provider-Switch via `LLM_PROVIDER=ollama|anthropic`
  - Modell-Default: `claude-haiku-4-5`
  - Same chat()-Interface, same conversationHistory-Format
  - Vergleich: Latenz, deutsche Sprachqualität, Kosten (Cloud → kein lokaler Datenschutz mehr → bewusste Opt-in-Entscheidung)
  - Hinweis: widerspricht dem „alles lokal"-Designziel — nur als optionaler Fallback / für Quick-Tests

---

## Phase 1 — Quick Wins

- [x] **Version-Anzeige in Bot-Activity** — Status zeigt Bot- + Server-Version (`1.4.1-<hash> (server:1.4.1-<hash>)`).
  - `getVersion()` in `apps/bot/src/version.js` und `apps/server/src/version.js`: liest `package.json`-Version + `git rev-parse --short HEAD` (gecacht, Fallback auf reine Paketversion ohne git)
  - `apps/bot/src/index.js`: `makeStatusText()`/`setBotStatus()` setzen die Custom-Activity; `clientReady` setzt sie initial (`server:null`), `transport.onServerInfo()` aktualisiert auf kombinierte Version bei Connect und zurück bei Disconnect
  - Server sendet seine Version im `hello`-Frame (`apps/server/src/control.js`, Feld `version`); Bot wertet sie über die Transport-Schicht aus
  - Es gibt **kein** hardcoded `SERVER_VERSION` mehr — beide Seiten lesen zur Laufzeit aus git

- [x] **Whisper `temperature` + `no_speech_prob`-Diagnostik** — T>0.0 liefert deutlich korrektere `no_speech_prob`-Werte.
  - Whisper-Aufruf-Parameter: `temperature` über `WHISPER_TEMPERATURE`
  - Live-Pfad verwirft aktuell nichts anhand von `no_speech_prob`
  - `noSpeechProbAvg`/`noSpeechProbMax` werden pro `user_transcript` im JSONL gespeichert
  - Spätere Feintuning-/Filtertests bleiben Aufgabe der Finalize-/Offline-Pipeline

---

## Phase 2 — Core Workflows

- [x] **Type-to-Ask (`/ask "Frage" tts:false`)** — Slash-Command und Mention-Trigger für Text-Queries.
  - Bot: `/ask frage:<text> tts:<bool>` + `@Botname Frage`
  - Bot: Handler sendet `text_query` über Control-Plane
  - Server: `runTextPipeline()` skippt STT/Wake-Word und nutzt dieselbe LLM-/History-/TTS-Pipeline
  - History-Mixing: Text- und Voice-Queries teilen sich bei aktiver Session `conversationHistory`
  - Sessionless erlaubt (Antwort nur als Discord-Text wenn Bot nicht im Voice-Channel)

- [x] **Server-Auto-Start via SSH bei `/join`** — Bot prüft Server-Erreichbarkeit, startet bei Bedarf via SSH.
  - Beim `/join`: TCP-Probe → falls offline: `SERVER_START_CMD`
  - Getestete Konfiguration: SSH auf Windows-Server, `Start-VoiceAssistant.ps1 -Mode silent`
  - Discord-Feedback während Start/Wartezeit
  - Timeout-Handling: nach 30 s ohne Server → Offline-Cache-Modus, Hinweis im Chat
  - Macht Feature `Autostart via Task Scheduler` (5.1) damit weitgehend obsolet

- [ ] **SSH-Host-Erreichbarkeit vor Auto-Start prüfen** — aktuell wird `SERVER_START_CMD` (SSH) ausgeführt und dann 30 s auf den Server gewartet, auch wenn der SSH-Zielhost gar nicht im Netz ist (z. B. PC aus). Das führt zu unnötigem Warten.
  - **Neue Logik in `apps/bot/src/serverAutoStart.js`**: vor `runStartCmd()` einen schnellen TCP-Check auf Port 22 des SSH-Hosts durchführen (Host aus `SERVER_SSH_HOST` oder aus `SERVER_START_CMD` parsen — einfachere Variante: neue Env-Var `SERVER_SSH_HOST=192.168.20.101`)
  - Wenn Port 22 nicht erreichbar: sofort `'no-route'` zurückgeben, **kein** `runStartCmd()`, kein 30-s-Warten
  - Discord-Feedback: „Server-PC nicht erreichbar (offline?) — trete ohne Server bei"
  - Wenn Port 22 erreichbar aber Server-Port noch offline: wie bisher SSH-Befehl + Poll
  - **Auto-Reconnect ist bereits implementiert** (`apps/bot/src/transport/control.js` hat Exponential-Backoff-Reconnect) — wenn der Server später doch hochkommt, verbindet sich der Bot automatisch ohne erneutes `/join`

- [ ] **`/start-server`-Command** — Server unabhängig von `/join` starten (z. B. vor der Session vorab hochfahren).
  - Neuer Slash-Command `start-server` in `apps/bot/src/commands.js`
  - Selbe Logik wie der Auto-Start-Pfad in `/join`: TCP-Probe → SSH-Erreichbarkeit → `runStartCmd()` → Poll mit Discord-Feedback
  - Kein Voice-Join — nur den Server hochfahren, Bot bleibt aus dem Channel
  - Wenn Server bereits online: „Server ist bereits erreichbar." zurückgeben
  - Design-Richtlinie beachten: `/start-server` als eigener Command akzeptabel da funktional klar getrennt von `/join` und selten genutzt; alternativ als `/join --no-voice` oder Subcommand überdenken

- [x] **Session-Log enriched (JSONL Schema v1)** — bestehender `transcripts/session_*.jsonl` wird angereichert.
  - Common fields: `tsMs`, `type`, `sessionId`
  - `session_meta` wird einmal pro Session geloggt: Discord-Kontext, Bot-/Server-Version, LLM-/STT-/TTS-Konfig, Wake-Word, Stop-Phrases, vorbereitetes `users`-Mapping
  - `user_transcript` enthält `startTsMs`, `endTsMs`, `durationMs`, STT-Chunks und `no_speech_prob`-Diagnostik; auch leere Whisper-Texte behalten Diagnostik; kein separates `utterance_end` im JSONL
  - Turn-/TTS-Lifecycle: `text_query`, `wakeword_query`, `assistant_response`, `tts_start`, `tts_done`, `tts_cancel`, `tts_error`
  - Unterbrechungen: `playback_paused`/`playback_resumed` mit `framesPlayed`, `msPlayed`, Pause-/Resume-/Rewind-Daten
  - Stop-Transcript: `assistant_response_played` wird bei Stop aus Playback-Dauer approximiert und natürlich gekürzt geloggt
  - Bewusst vorbereitet: `users`-Mapping für Discord-ID/Name → Spieler-/Charakter-/phonetischer Name; konkrete Mapping-Konfig später
  - Bewusst nicht enthalten: separate Join-/Leave-/Speaking-Dauer-Events, damit das Textlog nicht mit Transportereignissen überfüllt

---

## Phase 3 — Finalize-Pipeline

Kern der App: vom rohen Audio + JSONL-Log zum lesbaren Markdown-Transkript.

- [x] **`/finalize`-Command — Ist-Zustand prüfen + Soll definieren**
  - **Ist (Stand piper-rework)**: aktuell existiert `/save-session` (Bot-seitig) — ruft `mixSession()` auf, schreibt `session_mix.ogg`, schließt Session. **Kein** chronologisches Markdown-Transkript, **kein** Backlog-Transkribieren, **keine** WAV-Archivierung.
  - **TODO 0**: Code lesen (`apps/bot/src/index.js` `save-session`-Handler, `mixer.js`, Session-State) und dokumentieren was wirklich passiert vs. was die README/TODO behaupten
  - **TODO 1**: Soll-Verhalten entscheiden (umbenennen `/save-session` → `/finalize`? oder zwei getrennte Commands?)
  - Soll (laut Plan): Server transkribiert noch nicht-transkribierte Backlog-Chunks (Offline-Cache-Fall)
  - Soll: Erzeugt `transcripts/<datum>-<session-id>/transcript.md` (siehe Format in README)
  - Soll: Erzeugt OGG/Opus 32 kbps Audio-Archiv (gemerged oder pro Sprecher, noch zu klären)
  - Soll: Verschiebt/markiert Roh-WAVs ins Archive-Verzeichnis (1–6 Monate aufbewahren)
  - Soll: Discord-Feedback bei Erfolg/Fehler

- [x] **Chronologisches Transkript-Merge mit Monolog-Splitting** — der Algorithmus für das Format.
  - Eingabe: pro User die transkribierten Utterances mit Whisper-Token-Timestamps + Aufnahme-`startedAt` (siehe `apps/bot/src/recorder.js`)
  - Schritt 1: Utterances mit Absolut-Timestamps versehen (`startedAt + token.t0`)
  - Schritt 2: Pro langem Monolog (User1) prüfen, ob andere Spuren (User2/3) zeitlich überlappen
  - Schritt 3: Bei Überlapp Monolog an den Token-Grenzen *vor* der Unterbrechung splitten und Unterbrecher als `*[UserN unterbricht]*` einbetten
  - Schritt 4: Wenn User1 nach der Unterbrechung weitermacht → `*[UserN weiter]*` Marker
  - Pausen >30 s → `## HH:MM — Pause (N min)` Sub-Header
  - Wake-Word und Stop-Word im Output **fett** markieren (`**Rabenauge**`, `**Stop**`)
  - Eigenes Sub-Branch von Phase 3 (z. B. `feature/finalize-transcript-merge`) — nicht trivial

- [x] **Audio-Archiv** — OGG/Opus 32 kbps nach Finalize.
  - Während Aufnahme: hochqualitative WAVs bleiben (PCM 48 kHz/16-bit, ~1 GB/h pro Sprecher)
  - Bei `/finalize`: Container-Repack der Original-Opus-Frames in OGG (kein Re-Encode nötig — Discord liefert ja schon Opus)
  - Optional: gemerged in eine Datei, plus pro Sprecher eine Spur
  - Cleanup-Policy: Roh-WAVs nach erfolgreichem Finalize gelöscht oder verschoben (genau noch zu klären)

- [x] **Auto-Finalize (optional)** — 4 h nach `/leave` ohne erneutes `/join`, *nur wenn Server online*.
  - Timer-Logik mit Reset bei `/join`
  - Persistierung über Bot-Restart hinweg (sonst geht Timer verloren)
  - Bei Server-offline → Discord-Hinweis „Session muss manuell finalisiert werden"

- [ ] **Re-Finalize aus dem Archiv anbieten** — aktuell braucht `finalizeSession()` (`apps/server/src/finalize/index.js`) die transienten Upload-WAVs (`FINALIZE_UPLOAD_DIR`); nach dem üblichen Cleanup (`FINALIZE_KEEP_UPLOADS=false`, Standard) existieren die Original-WAVs nur noch im Langzeit-Archiv (`ARCHIVE_DIR/<session>/audio/*.wav` + `manifest.json`). Für eine bereits finalisierte Session gibt es aktuell keinen Weg, sie erneut zu transkribieren/mergen (z. B. nach einem Bugfix im Merge-Algorithmus).
  - Konkreter Anlass: Leerzeichen-Bug beim Zusammensetzen gesplitteter Unterbrecher-Spans aus Sub-Wort-Tokens (`words.map(w => w.w).join(' ')` in `apps/server/src/finalize/merge.js:442` — join fügt zwischen jedem Whisper-Token ein Leerzeichen ein, auch mitten im Wort: „Witch ern" statt „Witchern"). Das JSONL-`text`-Feld selbst ist sauber; nur der Weave-Reassembly-Pfad zerstört Wörter.
  - Neuer Server-Codepfad `finalizeFromArchive(archiveDirName)`: Manifest aus `ARCHIVE_DIR/<session>/manifest.json` statt aus dem Upload-Verzeichnis lesen, WAVs aus `ARCHIVE_DIR/<session>/audio/` statt `FINALIZE_UPLOAD_DIR` verwenden — sonst identischer Ablauf (re-STT optional überspringbar, wenn nur neu gemerged werden soll)
  - Bot-Seite: `/finalize show` und `/finalize run` scheitern aktuell auch an bereits archivierten Sessions, weil `SessionManager.loadById` nur im Bot-`DATA_DIR` sucht (`apps/bot/src/session.js`), nicht im Server-`ARCHIVE_DIR` — Session-ID vs. Archiv-Ordnername (`YYYY-MM-DDTHH-mm-ss-SSSZ`, UTC) ist zusätzlich verwirrend, da leicht mit Lokalzeit verwechselbar
  - Sollte auch reines Re-Merge (ohne erneute STT) unterstützen, wenn nur der Merge-/Weave-Code sich geändert hat — spart GPU-Zeit bei reinen Formatierungs-Fixes

- [ ] **Optional: LLM-Summary bei Finalize** — analog Meeting-Minutes.
  - Eigener Block im Markdown, separat vom rohen Transkript
  - Modell-Wahl noch offen (gleiches Ollama-Modell oder kleineres/schnelleres)
  - Pen-and-Paper-spezifischer System-Prompt (Spielinhalt vs. Off-Topic)

---

## Phase 4 — RAG + Obsidian

Voraussetzung: Phase-2-Session-Log enriched (Phase 3 unabhängig parallel).

- [x] **`feature/rag-service`** — neuer Python-Dienst `apps/rag/` (FastAPI + ChromaDB + Ollama-Embeddings).
  - Vault-Scanner: parst `.md` + Frontmatter, chunked nach `##`-Sections (`apps/rag/server.py`)
  - Embeddings via Ollama (`nomic-embed-text`) — kein zusätzlicher Service nötig
  - Filewatcher (`watchdog`) für debounced Re-Index einzelner Notes
  - Endpunkte: `POST /query`, `POST /index`, `GET /health`
  - Env: `VAULT_PATH`, `CHROMA_DIR`, `OLLAMA_URL`, `EMBED_MODEL`, `RAG_PORT`; Start/Stop via `scripts/Start-VoiceAssistant.ps1`
  - Voraussetzungen: `ollama pull nomic-embed-text`, eigenes venv in `apps/rag/`
  - **Score-Threshold-Filter** (2.1.0): `RAG_SCORE_THRESHOLD` (max. Cosine-Distanz, 0=identisch..2=entgegengesetzt) filtert `/query`-Treffer serverseitig (`server.py`, `_apply_threshold`), pro Request via `score_threshold` überschreibbar; `ragClient.js` liest den Env-Wert frisch pro Call und hängt ihn nur an, wenn gesetzt
  - **Docker-Deploy** (2.1.0): `apps/rag/Dockerfile` (non-root, setpriv-Privilegien-Drop wie der Server-Container), `rag`-Service im Cloud-Compose-Stack (`deploy/docker-compose.yml`, Vault-Volume ro, eigenes `rag-chroma`-Volume, Healthcheck), `RAG_EMBED_MODEL`-Pull in `deploy/scripts/start.sh`, alle `RAG_*`-Vars in `deploy/.env.example`

- [x] **`feature/obsidian-per-query`** — Vault-Kontext bei jedem Wake-Word-Call.
  - `apps/server/src/ragClient.js`: `queryRag(query, topK)` über native `fetch`, fail-soft mit Timeout (`RAG_TIMEOUT_MS`, Default 800ms)
  - `getCampaignContext(query)` ist jetzt async: bei gesetztem `RAG_URL` semantische Suche, sonst/bei Fehler Fallback auf `CAMPAIGN.md`
  - `buildSystemBlocks()` awaitet den Lookup; Top-K Chunks als `role: system`-Präambel (nicht in History persistiert)
  - `RAG_SCORE_THRESHOLD` (2.1.0) filtert schwache Treffer bereits im RAG-Service weg, bevor sie hier ankommen (s. `feature/rag-service`)

- [x] **`feature/obsidian-session-start`** — Briefing beim `/join`.
  - Vault-Chunks als `role: system`-Message am Anfang der `conversationHistory`
  - Ersetzt (Okt. 2026): kein automatisches /join-Briefing mehr — Finalize schreibt `summary.md`, die letzte Zusammenfassung ist Kontext für Anfragen, `/recap` auf Nachfrage
  - Durchgängig best-effort: No-op wenn RAG aus, kein Summary vorhanden oder ein Call fehlschlägt
  - Alle RAG-Env-Vars seit 2.1.0 im Settings-Katalog (`configCatalog.js` + `config_state` in `control.js`) — sichtbar/konfigurierbar im Web-Panel

- [x] **`feat/rag-in-node`** — RAG in den Node-Server verlegt; Python-Dienst, `va-rag`-Image und pytest-CI-Job entfernt.
  - `apps/server/src/rag/`: Frontmatter (`yaml`, rein JS), `##`-Chunking, Vault-Scan, Float32-Brute-Force-Cosinus, atomar persistierter Index (`RAG_INDEX_DIR`, Compose: `/data/rag` auf `server-data`), inkrementeller Single-Flight-Sync, `fs.watch`-Watcher + periodischer Abgleich
  - Embeddings über `providers/embed.js` (Ollama oder OpenAI-kompatibel); `ragClient.js` entfällt, `RAG_URL` ebenso; neu: `RAG_ENABLED`, `RAG_MAX_CHUNK_CHARS`, `RAG_RESCAN_INTERVAL_MS`, `EMBED_*`
  - Die pytest-Suite ist nach `node:test` portiert (`apps/server/test/rag*.test.js`); Doku: [`docs/rag.md`](docs/rag.md)
  - Die Einträge oben beschreiben den historischen Python-Stand (`apps/rag/`, ChromaDB, `RAG_URL`)

- [ ] **`feature/obsidian-write-notes`** *(später)* — automatische Session-Notes.
  - Format und Vault-Pfad noch offen
  - Erst nach Erfahrung mit Read-Only-Integration

---

## Phase 5 — Web-UI

- [x] **Live-Transkript-Web-UI** — umgesetzt: read-only Browser-View unter `/transcript/` auf dem Server-Port (statisch aus `apps/server/src/public/`, kein Build, keine Fremdaufrufe). SSE (`/transcript/live`) primär, JSON-Polling (`/transcript/snapshot/:id`) als Fallback. Volle History beim Aufruf aus dem JSONL rekonstruiert (überlebt Reload + Summary-Folding); gefaltete Turns als einklappbare Zusammenfassung. Markdown-Rendering, farbige Sprechernamen (Rabenauge in Akzentfarbe), selbst gehostete Roboto-Schrift, `?debug=1` (Timestamps, Event-Art, `no_speech_prob`). Basic-Auth standardmäßig an (`greyhawk`/`greyhawk`, per `TRANSCRIPT_UI_*` konfigurier-/abschaltbar). Pub/sub `liveBus.js`; Endpunkte `transcriptApi.js` + `transcriptView.js` + `transcriptAuth.js`.
  - Auto-Sync / Auto-Reload (Server-sent events oder einfaches Polling)
  - Useful für Debugging *und* als Spieler-Begleit-Display während der Session
  - Reines Read-Only, kein User-Input
  - Renderer kann den Markdown direkt anzeigen, oder strukturiert mit Sprecher-Spalten / Timestamps für Debug-Modus
  - **Erweiterungen (1.5.1/1.5.2)**: Voice-Status-Pill + Member-Popover im Header (live `presence`); Session-Picker mit lesbaren Zeitstempeln + Checkbox für vergangene Sessions (`?all=1`, JSONL-Scan); Wake-Word-Markierung der ganzen getriggerten Zeile + Stop-Token-Markierung (live via `annotation`); Debug-Modus erweitert um STT-Diagnostik, TTS-Lifecycle/Interrupts und einklappbaren `session_meta`-Header; Mobile-Topbar-Fix.

---

## Power-User Features

> **Design-Richtlinie: so wenige Slash-Commands wie möglich.**
> Discord zeigt alle registrierten Commands in einer Liste — zu viele (`/model`, `/debug`, `/config`, `/sleep`, …) wirken unübersichtlich.
> Neue Funktionen wo möglich als **Subcommands** eines bestehenden Commands bündeln, nicht als eigene Top-Level-Commands.
> Angestrebte Command-Liste gesamt: `/join`, `/leave`, `/ask`, `/config`, `/finalize` — alles andere als Subcommand darunter.
> Beispiel: `WAKE_WORD`-Änderung → `/config set wake_word …`; Modell-Wechsel → `/config set model …`; Debug-Toggle → `/config debug on`.

- [ ] **`/config`** — alle Laufzeit-Settings in einem Command (ersetzt geplante Einzelcommands `/model`, `/list-models`, `/debug`, `/sleep`/`/wake`).
  - Subcommands: `/config list`, `/config set <key> <value>`, `/config debug on|off`
  - Konfigurierbare Keys: WAKE_WORD, HISTORY_TURNS, TTS-Provider/Voice, LLM-Modell (inkl. Auto-Complete via `/api/tags`), Stop-Phrases, Whisper-Temperature
  - Permission-Check (Admin only?)
  - In-Memory-State sofort; **Persistenz prüfen**: nötig wenn Änderungen Server-Restart überleben sollen — JSON-File in `apps/server/data/` als Override über `.env`, beim Start einlesen
  - Alternativ ohne Persistenz: Änderungen gelten nur bis zum nächsten Server-Restart (einfacher, evtl. ausreichend wenn `/config` selten genutzt wird)

- [ ] **Sleep/Wake als `/config`-Subcommand** — niedrige Priorität.
  - `config set sleep true/false` oder eigener Subcommand `/config sleep`
  - Wake-Word vorübergehend deaktivieren (z. B. während privater Plauderei)
  - **Begründung für niedrige Prio**: Stop-Command unterbricht False-Positives bereits sehr gut

- [ ] **`/config debug on|off`** — Live-Debug-Output für den auslösenden User (kein eigener Top-Level-Command).
  - **Ziel**: alle Transkripte (STT, Wake-Word-Treffer, LLM-Antworten, Latenz/Buffer-Metriken) sieht **nur der auslösende User**, idealerweise als fortlaufend editierte Ephemeral-Message (oder DM) — kein Channel-Spam
  - `/debug on` öffnet einen Ephemeral-Slot, der bei jedem Server-Event aktualisiert wird (oder rotierend ein paar Messages, falls 4000-Zeichen-Limit gerissen wird)
  - `/debug off` schließt den Slot
  - Server sendet Events über Control-Plane (`debug_event`); Bot routet nur an User mit aktivem Debug-Slot
  - Edge-Case: Ephemeral-Messages haben eine Lebensdauer — Strategie wenn Discord die Message verwirft (neue erzeugen)

---

## Optimierungen / später

- [ ] **Whisper Temperature-Feintuning** — größere Test-Matrix nach MVP.
  - 3–4 Audio-Samples × 5–6 Temperaturen
  - Output: Transkript, `avg_logprob`, `no_speech_prob`, mean/median Token-`probability`
  - Nur sinnvoll wenn Phase-1-Default sich als suboptimal zeigt

- [ ] **Wort-Probabilitäts-Markierung** — unsichere Wörter mit `[unsicher]` im Log.
  - Nice-to-have für Audits, niedriger Impact

- [x] **Streaming-STT (LocalAgreement) statt Chunk-Transkription** — umgesetzt in `feature/streaming-stt` (`apps/server/src/sttStreaming.js`).
  - Live-Pfad ohne Chunk-Grenzen: wachsendes Fenster jede Sekunde als Ganzes transkribieren, Wörter nach doppelter Bestätigung committen (LocalAgreement-2), Fenster an bestätigten Satzgrenzen fixieren (`STT_STREAM_TRIM_SECONDS`), fixierten Text als Whisper-Prompt weiterreichen
  - Fixt den Duplikations-Bug der Forced-Overlap-Chunks doppelt: Live-Pfad hat keine Chunks mehr; der verbleibende Fallback-/Finalize-Pfad schneidet den Overlap jetzt zeitbasiert über Wort-Zeitstempel (`stitchByTime`) statt per Textvergleich
  - Utterance-Ende: nur noch Restfenster-Transkription (0,5 s statt 10 s bei 86 s Rede); bestätigte Wörter werden nie zurückgenommen
  - Web-UI: Wort-für-Wort-Rendering mit Blur→Sharpen-Einblendung, Morph bei Korrekturen, gedimmte unbestätigte Wörter, sanfte Bubble-Höhenanimation
  - Messung (tests/Quantengravitation.m4a, 86 s, RX 6800 XT Vulkan medium-q5_0): erstes Partial nach ~1 s, Ø-Tick 0,7 s, WER 2,6 % (Chunk-Pfad: 8,4 %), 0 Text-Dopplungen
  - E2E-Simulation: `node tests/ui-sim.mjs` (Server auf :7441, speist das Testaudio in Echtzeit ein)

- [ ] **Verbessertes Stitching innerhalb einer Utterance** — Whisper-Timestamps statt RMS für Silence-Splitting.
  - Match nächstes Audio-Snippet bei zuletzt erkanntem Satzzeichen (`.!?`)
  - Großer Aufwand (~3–4 h), MVP-irrelevant
  - Teilweise durch Streaming-STT erledigt (Live-Pfad chunk-frei; `stitchByTime` nutzt Timestamps)

- [x] **`session-rolling-summary`** — umgesetzt in `feature/live-transcript-llm-context` (`apps/server/src/rollingSummary.js`). Statt `conversationHistory` faltet der Live-Transkript-Puffer ältere Turns asynchron in eine rollende Zusammenfassung (Schwellen `LIVE_RAW_WINDOW_CHARS`/`LIVE_FOLD_CHARS`, Single-Flight, Remove-after-Success). Gegen Token-Blowup bei Mehrstunden-Sessions.

- [ ] **Conversation-History persistent als Markdown** — Sessions überleben Bot-Restart.
  - Format als Markdown (nicht JSON), damit der Inhalt direkt vom LLM als Kontext lesbar ist
  - Nur sinnvoll im Verbund mit „Transkript als Kontext" — sonst zu viel/zu langer Kontext, der das LLM verwirrt
  - Nicht eilig, evtl. ganz verworfen wenn `obsidian-per-query` (Phase 4) sowieso den nötigen Kontext liefert

- [x] **Transkript als LLM-Kontext** — umgesetzt in `feature/live-transcript-llm-context`. Live-Transkript (alle Sprecher) + rollende Zusammenfassung + statischer Kampagnen-Kontext (`CAMPAIGN.md`, Variante A) werden als `system`-Blöcke bei jedem Wake-Word-/Text-Call eingespielt (`apps/server/src/liveContext.js`, `rollingSummary.js`, `campaignContext.js`). Format: leserliches `[Label] Text` ohne Steuerzeichen. Bei Resume aus dem JSONL rekonstruiert. RAG (`obsidian-per-query`, Phase 4) kann den Kampagnen-Block später ersetzen (Signatur `getCampaignContext(query)` ist vorbereitet).

- [x] **`Pipecat TTS Service Spec`-konforme TTS-API** — `GET /voices` Endpoint + `Content-Type: audio/pcm-s16le` Header hinzugefügt (`feature/piper-pipeline-rework`).

- [ ] **Autostart via Windows Task Scheduler** — wird durch „Server-Auto-Start via SSH bei `/join`" weitgehend redundant. Falls noch gebraucht: `Start-VoiceAssistant.ps1 -Mode silent` als Aufgabe „bei PC-Entsperrung".

- [x] **`package.json` Engine-Bump** (1.4.1) — `engines.node` von `>=20` auf `>=22` in Root-, Bot- und Server-`package.json`.

---

## ✅ Done

- [x] **Piper TTS auf GPU (DirectML)** — bestätigt 1.93× Speedup auf AMD RX 6800 XT.
- [x] **Piper Streaming-API** — `POST /tts/synthesize` mit chunked HTTP-Streaming (Satz-für-Satz → niedrigere TTFA).
- [x] **TTS-Settings konfigurierbar** — `length_scale`, `noise_scale`, `noise_w_scale` per Request; Voice-Wechsel per `model`-Feld.
- [x] **FIFO-TTS-Playback-Pfad** — Bot spielt Server-Opus-Frames über `tts_start`/`tts_frame`/`tts_done` in FIFO-Reihenfolge, ohne JitterBuffer/Timestamp-Scheduling/Stale-Drops im aktiven TTS-Pfad.
- [x] **TTS-Unterbrechung mit Resume/Rewind** — User-Sprache pausiert Playback nach `INTERRUPT_MIN_MS`, Resume nach `RESUME_GATE_MS`, Wiederholung über `REWIND_MS`.
- [x] **Konfigurierbare Stop-Phrases** — `STOP_PHRASES` und `STOP_WITHOUT_WAKE_MAX_WORDS`; Stop bricht Playback und laufenden TTS-Stream ab.
- [x] **STT-Split-Debug** — lange Utterances loggen bei `DEBUG=1` Chunk-Dauern, Threshold und Split-Typ; `STT_MAX_CHUNK_SECONDS` ist konfigurierbar.
- [x] **`/ask` + `@mention` History-Scoping** — Requests aus dem Text-Chat des aktiven Voice-Channels teilen die Voice-Session-History; andere Text-Channels behalten je eine eigene channel-scoped History (server-seitig `sessionlessHistory(channel_<id>)`). Normale Chat-Nachrichten ohne Mention werden ignoriert.

---

## Verworfen

- **whisper-amd-windows (ChharithOeun) als STT-Backend** — evaluiert und lokal getestet (2026-07-02, vor `feature/streaming-stt`). Nicht kompatibel mit dem Streaming-Ziel und dem Setup: (1) explizit **kein** Streaming/Server/Mikrofon — nur dateibasierte Batch-Transkription; (2) das DirectML-Versprechen hält nicht — faster-whisper/CTranslate2 kennt kein DirectML, `transcribe.py` crasht mit `unsupported device directml` (die GPU-Erkennung prüft nur ONNX-Provider, die mit der Whisper-Inferenz nichts zu tun haben); (3) weitere Bugs: falscher kwarg `word_level_timestamps` (crasht jede Transkription), `verify_gpu.py` crasht an cp1252, requirements.txt installiert das CPU-`onnxruntime` über das DirectML-Paket; (4) gemessener CPU-Fallback: **0,4× Echtzeit** (small int8) vs. **16–24× Echtzeit** des bestehenden whisper.cpp-Vulkan-Servers (medium-q5_0, warm). Der Vulkan-Server bleibt; NVIDIA-Umzug später über den CUDA-Build von whisper.cpp (identische HTTP-API).
- **Mehrere gleichzeitige Sessions** — Bot ist bewusst auf einen Voice-Channel beschränkt.
- **`/redact`-Command** — würde LLM-Entscheidungen erfordern. Off-Topic-Filter passiert manuell oder in der externen Cowork-Pipeline.
- **`/marker`-Command** — gleiches Argument; Anker im Transkript besser über Pause-Erkennung + Spielernotizen.
- **Live-Stitching der Monolog-Unterbrechungen** — zu komplex; nur im Finalize-Pfad gelöst (Live-Log darf chronologisch leicht falsch sein).
- **Aufholen-während-Live-Modus** (Server kommt mitten in der Session dazu und verarbeitet Backlog parallel) — eine GPU, Konflikt mit Live-Last; stattdessen klare Zustände Online-Live / Offline-Cache / Finalize.
