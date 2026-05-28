# TODO & Ideen

Backlog/Brainstorm. Priorisierter Plan: `~/.claude/plans/schau-in-die-todo-shimmying-phoenix.md`. Mental Model und Operating Modes: siehe [`README.md`](README.md).

> **Versionierung**: Bot + Server teilen `MAJOR.PHASE.PATCH` (z. B. `1.1.0` = nach Phase 1). Bump am Ende jeder Phase. Details im Plan-File.

---

## Performance / Stabilität

- [ ] **LLM-Keep-Warm beim Server-Start + `/join`** — aktuelle Symptome: Server-Start dauert lang; Ollama-Modell wird nach wenigen Minuten Idle aus dem VRAM entladen und muss bei der nächsten Wake-Word-Query erneut geladen werden (mehrere Sekunden Latenz).
  - Beim Server-Start: leeren Chat-Call gegen das konfigurierte `OLLAMA_MODEL` absetzen, damit das Modell in den VRAM kommt
  - Bei `/join`: erneut einen „warm-up"-Call absetzen (Server kann zwischenzeitlich idle gewesen sein)
  - Periodischer Keep-Alive während aktiver Session (z. B. alle 2 min ein leerer/minimaler Call), solange der Bot im Voice-Channel ist
  - Ollama-Parameter `keep_alive` im Request auf z. B. `30m` setzen — vermeidet das Idle-Unloading server-seitig
  - Messen: Warm-Latenz vs. Cold-Latenz dokumentieren (DEBUG-Log)

- [ ] **Claude Haiku API als optionaler LLM-Provider** — Vergleichstest gegen lokales Ollama.
  - API-Key-Setup (`ANTHROPIC_API_KEY` in `.env`), Provider-Switch via `LLM_PROVIDER=ollama|anthropic`
  - Modell-Default: `claude-haiku-4-5`
  - Same chat()-Interface, same conversationHistory-Format
  - Vergleich: Latenz, deutsche Sprachqualität, Kosten (Cloud → kein lokaler Datenschutz mehr → bewusste Opt-in-Entscheidung)
  - Hinweis: widerspricht dem „alles lokal"-Designziel — nur als optionaler Fallback / für Quick-Tests

---

## Phase 1 — Quick Wins

- [ ] **Version-Anzeige in Bot-Activity** — Status zeigt Bot- + Server-Version (`1.0.1-d5b717a (server:1.0.1-d5b717a)`).
  - `package.json`-Version + `git rev-parse --short HEAD` automatisch beim Start lesen
  - `apps/server/src/control.js`: hardcoded `SERVER_VERSION = '0.1.0'` durch `getVersionString()` ersetzen
  - `apps/bot/src/index.js`: `clientReady` → Activity setzen; `hello`-Handler → kombinierte Version updaten; Disconnect → zurücksetzen
  - `apps/bot/src/transport/control.js`: `hello`-Message auswerten und Server-Version weitergeben
  - Hilfsfunktion `getVersionString()` jeweils einmal in bot und server

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

- [ ] **`/finalize`-Command — Ist-Zustand prüfen + Soll definieren**
  - **Ist (Stand piper-rework)**: aktuell existiert `/save-session` (Bot-seitig) — ruft `mixSession()` auf, schreibt `session_mix.ogg`, schließt Session. **Kein** chronologisches Markdown-Transkript, **kein** Backlog-Transkribieren, **keine** WAV-Archivierung.
  - **TODO 0**: Code lesen (`apps/bot/src/index.js` `save-session`-Handler, `mixer.js`, Session-State) und dokumentieren was wirklich passiert vs. was die README/TODO behaupten
  - **TODO 1**: Soll-Verhalten entscheiden (umbenennen `/save-session` → `/finalize`? oder zwei getrennte Commands?)
  - Soll (laut Plan): Server transkribiert noch nicht-transkribierte Backlog-Chunks (Offline-Cache-Fall)
  - Soll: Erzeugt `transcripts/<datum>-<session-id>/transcript.md` (siehe Format in README)
  - Soll: Erzeugt OGG/Opus 32 kbps Audio-Archiv (gemerged oder pro Sprecher, noch zu klären)
  - Soll: Verschiebt/markiert Roh-WAVs ins Archive-Verzeichnis (1–6 Monate aufbewahren)
  - Soll: Discord-Feedback bei Erfolg/Fehler

- [ ] **Chronologisches Transkript-Merge mit Monolog-Splitting** — der Algorithmus für das Format.
  - Eingabe: pro User die transkribierten Utterances mit Whisper-Token-Timestamps + Aufnahme-`startedAt` (siehe `apps/bot/src/recorder.js`)
  - Schritt 1: Utterances mit Absolut-Timestamps versehen (`startedAt + token.t0`)
  - Schritt 2: Pro langem Monolog (User1) prüfen, ob andere Spuren (User2/3) zeitlich überlappen
  - Schritt 3: Bei Überlapp Monolog an den Token-Grenzen *vor* der Unterbrechung splitten und Unterbrecher als `*[UserN unterbricht]*` einbetten
  - Schritt 4: Wenn User1 nach der Unterbrechung weitermacht → `*[UserN weiter]*` Marker
  - Pausen >30 s → `## HH:MM — Pause (N min)` Sub-Header
  - Wake-Word und Stop-Word im Output **fett** markieren (`**Rabenauge**`, `**Stop**`)
  - Eigenes Sub-Branch von Phase 3 (z. B. `feature/finalize-transcript-merge`) — nicht trivial

- [ ] **Audio-Archiv** — OGG/Opus 32 kbps nach Finalize.
  - Während Aufnahme: hochqualitative WAVs bleiben (PCM 48 kHz/16-bit, ~1 GB/h pro Sprecher)
  - Bei `/finalize`: Container-Repack der Original-Opus-Frames in OGG (kein Re-Encode nötig — Discord liefert ja schon Opus)
  - Optional: gemerged in eine Datei, plus pro Sprecher eine Spur
  - Cleanup-Policy: Roh-WAVs nach erfolgreichem Finalize gelöscht oder verschoben (genau noch zu klären)

- [ ] **Auto-Finalize (optional)** — 4 h nach `/leave` ohne erneutes `/join`, *nur wenn Server online*.
  - Timer-Logik mit Reset bei `/join`
  - Persistierung über Bot-Restart hinweg (sonst geht Timer verloren)
  - Bei Server-offline → Discord-Hinweis „Session muss manuell finalisiert werden"

- [ ] **Optional: LLM-Summary bei Finalize** — analog Meeting-Minutes.
  - Eigener Block im Markdown, separat vom rohen Transkript
  - Modell-Wahl noch offen (gleiches Ollama-Modell oder kleineres/schnelleres)
  - Pen-and-Paper-spezifischer System-Prompt (Spielinhalt vs. Off-Topic)

---

## Phase 4 — RAG + Obsidian

Voraussetzung: Phase-2-Session-Log enriched (Phase 3 unabhängig parallel).

- [ ] **`feature/rag-service`** — neuer Python-Dienst `apps/rag/` (FastAPI + ChromaDB + Ollama-Embeddings).
  - Vault-Scanner: parst `.md` + Frontmatter, chunked nach `##`-Sections
  - Embeddings via Ollama (`nomic-embed-text`) — kein zusätzlicher Service nötig
  - Filewatcher für Re-Index
  - Endpunkte: `POST /query`, `POST /index`, `GET /health`
  - Voraussetzungen: `ollama pull nomic-embed-text`, `VAULT_PATH`, `CHROMA_DIR`

- [ ] **`feature/obsidian-session-start`** — Briefing beim `/join`.
  - Server bekommt `session_start`-Event → RAG-Query mit letztem Session-Summary als Suchkontext
  - Top-K Chunks → LLM erzeugt Briefing („Wo wir letztes Mal aufgehört haben …")
  - Als `role: system`-Message am Anfang der `conversationHistory`
  - Optional: Discord-Text-Nachricht mit dem Briefing

- [ ] **`feature/obsidian-per-query`** — Vault-Kontext bei jedem Wake-Word-Call.
  - Async RAG-Query parallel zu STT/LLM
  - Score-Threshold konfigurierbar
  - Top-3 Chunks als `role: system`-Präambel (nicht in History persistiert)

- [ ] **`feature/obsidian-write-notes`** *(später)* — automatische Session-Notes.
  - Format und Vault-Pfad noch offen
  - Erst nach Erfahrung mit Read-Only-Integration

---

## Phase 5 — Web-UI

- [ ] **Live-Transkript-Web-UI** — Browser-View für das laufende Transkript.
  - Auto-Sync / Auto-Reload (Server-sent events oder einfaches Polling)
  - Useful für Debugging *und* als Spieler-Begleit-Display während der Session
  - Reines Read-Only, kein User-Input
  - Renderer kann den Markdown direkt anzeigen, oder strukturiert mit Sprecher-Spalten / Timestamps für Debug-Modus

---

## Power-User Features

- [ ] **`/model <name>` + `/list-models`** — LLM-Modell zur Laufzeit wechseln.
  - Server liefert Liste verfügbarer Ollama-Modelle (`/api/tags`)
  - Bot zeigt sie als Auto-Complete-Choices im Slash-Command
  - Switch in `runPipeline` ohne Server-Neustart

- [ ] **`/config`** — Settings zur Laufzeit über Discord ändern (z. B. WAKE_WORD, HISTORY_TURNS, TTS-Provider/Voice, LLM-Modell, Stop-Phrases, Whisper-Temperature).
  - Permission-Check (Admin only?)
  - In-Memory-State sofort; **Persistenz prüfen**: nötig wenn Änderungen Server-Restart überleben sollen — JSON-File in `apps/server/data/` als Override über `.env`, beim Start einlesen
  - Alternativ ohne Persistenz: Änderungen gelten nur bis zum nächsten Server-Restart (einfacher, evtl. ausreichend wenn `/config` selten genutzt wird)
  - Auflisten + Setzen einzelner Keys (`/config list`, `/config set <key> <value>`)

- [ ] **`/sleep` / `/wake`** — niedrige Priorität (laut Diskussion).
  - Wake-Word vorübergehend deaktivieren (z. B. während privater Plauderei)
  - **Begründung für niedrige Prio**: Stop-Command unterbricht False-Positives bereits sehr gut; eigener Sleep-Modus ist nicht kritisch

- [ ] **`/debug on|off`** — Live-Debug-Output für den auslösenden User.
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

- [ ] **Verbessertes Stitching innerhalb einer Utterance** — Whisper-Timestamps statt RMS für Silence-Splitting.
  - Match nächstes Audio-Snippet bei zuletzt erkanntem Satzzeichen (`.!?`)
  - Großer Aufwand (~3–4 h), MVP-irrelevant

- [ ] **`session-rolling-summary`** — Llama fasst alle N Turns zu Summary, ersetzt alte Turns in `conversationHistory`.
  - N=10 konfigurierbar
  - Gegen Token-Blowup bei Mehrstunden-Sessions

- [ ] **Conversation-History persistent als Markdown** — Sessions überleben Bot-Restart.
  - Format als Markdown (nicht JSON), damit der Inhalt direkt vom LLM als Kontext lesbar ist
  - Nur sinnvoll im Verbund mit „Transkript als Kontext" — sonst zu viel/zu langer Kontext, der das LLM verwirrt
  - Nicht eilig, evtl. ganz verworfen wenn `obsidian-per-query` (Phase 4) sowieso den nötigen Kontext liefert

- [ ] **Transkript als LLM-Kontext** — laufendes Session-Transkript bzw. dessen Summary als Kontext bei Wake-Word-LLM-Calls einspielen.
  - Eingabe: Markdown-Transkript der laufenden Session (siehe Format in README)
  - Open: ganzer Inhalt vs. Rolling-Summary (zu viel Text verwirrt das LLM)
  - Hängt zusammen mit `session-rolling-summary` (oben) und `obsidian-per-query` (Phase 4) — ggf. überflüssig wenn RAG den nötigen Kontext liefert
  - Format: leserliches Markdown (Speaker/Text), keine Steuerzeichen/JSON-Klammern. Falls LLM JSON ausgeben soll, dialog auch in JSON-Form serialisieren — sonst Markdown

- [x] **`Pipecat TTS Service Spec`-konforme TTS-API** — `GET /voices` Endpoint + `Content-Type: audio/pcm-s16le` Header hinzugefügt (`feature/piper-pipeline-rework`).

- [ ] **Autostart via Windows Task Scheduler** — wird durch „Server-Auto-Start via SSH bei `/join`" weitgehend redundant. Falls noch gebraucht: `Start-VoiceAssistant.ps1 -Mode silent` als Aufgabe „bei PC-Entsperrung".

- [ ] **`package.json` Engine-Bump** — aktuell `node>=20`, benötigt aber 22.

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

- **WebSocket-basiertes Piper-Streaming** (`piper-streaming` / `paroli`) — evaluiert in `feature/piper-pipeline-rework`. HTTP-Chunked-Streaming liefert identische TTFA (first-byte innerhalb von 100–200 ms), kein messbarer Vorteil für unser 0.5–2s End-to-End-Ziel. Aufwand >> Nutzen.
- **Mehrere gleichzeitige Sessions** — Bot ist bewusst auf einen Voice-Channel beschränkt.
- **`/redact`-Command** — würde LLM-Entscheidungen erfordern. Off-Topic-Filter passiert manuell oder in der externen Cowork-Pipeline.
- **`/marker`-Command** — gleiches Argument; Anker im Transkript besser über Pause-Erkennung + Spielernotizen.
- **Live-Stitching der Monolog-Unterbrechungen** — zu komplex; nur im Finalize-Pfad gelöst (Live-Log darf chronologisch leicht falsch sein).
- **Aufholen-während-Live-Modus** (Server kommt mitten in der Session dazu und verarbeitet Backlog parallel) — eine GPU, Konflikt mit Live-Last; stattdessen klare Zustände Online-Live / Offline-Cache / Finalize.
