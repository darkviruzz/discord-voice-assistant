# TODO & Ideen

Backlog/Brainstorm. Priorisierter Plan: `~/.claude/plans/schau-in-die-todo-shimmying-phoenix.md`. Mental Model und Operating Modes: siehe [`README.md`](README.md).

> **Versionierung**: Bot + Server teilen `MAJOR.PHASE.PATCH` (z. B. `1.1.0` = nach Phase 1). Bump am Ende jeder Phase. Details im Plan-File.

---

## Phase 1 — Quick Wins

- [ ] **Version-Anzeige in Bot-Activity** — Status zeigt Bot- + Server-Version (`1.0.1-d5b717a (server:1.0.1-d5b717a)`).
  - `package.json`-Version + `git rev-parse --short HEAD` automatisch beim Start lesen
  - `apps/server/src/control.js`: hardcoded `SERVER_VERSION = '0.1.0'` durch `getVersionString()` ersetzen
  - `apps/bot/src/index.js`: `clientReady` → Activity setzen; `hello`-Handler → kombinierte Version updaten; Disconnect → zurücksetzen
  - `apps/bot/src/transport/control.js`: `hello`-Message auswerten und Server-Version weitergeben
  - Hilfsfunktion `getVersionString()` jeweils einmal in bot und server

- [ ] **Whisper `temperature=0.2` + `no_speech_prob`-Filter (Kombo)** — bereits informell verifiziert: T>0.0 liefert deutlich korrektere `no_speech_prob`-Werte. Reasonable conservative estimates ohne weiteren Test-Aufwand:
  - Whisper-Aufruf-Parameter: `temperature: 0.2`
  - In `apps/server/src/stt.js` (oder pipeline): wenn `no_speech_prob > 0.67` → Transkript verwerfen, leeren String zurückgeben
  - Spätere Feintuning-Tests (Test-Matrix mit mehr Audio-Samples) verschoben auf „Optimierungen"

---

## Phase 2 — Core Workflows

- [ ] **Type-to-Ask (`/ask "Frage" tts:false`)** — Slash-Command für Text-Queries.
  - Bot: neuer Slash-Command mit `question` (string, required) + `tts` (bool, default false)
  - Bot: Handler sendet `text_query`-Message über Control-Plane
  - Server: neue `runTextPipeline()` skippt STT, startet bei LLM, reuse `chat()` + `synthesize()` + History-Management
  - History-Mixing: Text- und Voice-Queries teilen sich `conversationHistory`
  - Sessionless erlaubt (Antwort nur als Discord-Text wenn Bot nicht im Voice-Channel)

- [ ] **Server-Auto-Start via SSH bei `/join`** — Bot prüft Server-Erreichbarkeit, startet bei Bedarf via SSH.
  - SSH-Infra existiert bereits (anderweitig genutzt) — kein WoL nötig
  - Beim `/join`: Ping → falls offline: SSH-Aufruf von `Start-VoiceAssistant.ps1`
  - Discord-Feedback: „Server wird gestartet, Moment …" → später „Bereit, Aufnahme läuft."
  - Timeout-Handling: nach X Sekunden ohne Server → Offline-Cache-Modus, Hinweis im Chat
  - Macht Feature `Autostart via Task Scheduler` (5.1) damit weitgehend obsolet

- [ ] **Session-Log enriched (JSONL)** — bestehender `transcripts/session_*.jsonl` wird angereichert.
  - Pro Turn: Timestamp, Speaker-ID, ggf. Wake-Word-Query, LLM-Antwort, TTS-Speaker-Emotion
  - Optionale Bot-Events (join/leave, wer spricht wann)
  - Periodische Checkpoint-Snapshots (alle 30 min) — kompakter Kontext-Stand
  - Format-Standard hier festlegen, weil Phase-3-Finalize und Phase-4-RAG darauf aufbauen

---

## Phase 3 — Finalize-Pipeline

Kern der App: vom rohen Audio + JSONL-Log zum lesbaren Markdown-Transkript.

- [ ] **`/finalize`-Command** — manuell getriggert nach Session-Ende (auch bei online-Session, weil Audio-Archiv + Transkript-Merge sonst nicht entstehen).
  - Server transkribiert noch nicht-transkribierte Backlog-Chunks (Offline-Cache-Fall)
  - Erzeugt `transcripts/<datum>-<session-id>/transcript.md` (siehe Format in README)
  - Erzeugt OGG/Opus 32 kbps Audio-Archiv (gemerged oder pro Sprecher, noch zu klären)
  - Verschiebt/markiert Roh-WAVs ins Archive-Verzeichnis (1–6 Monate aufbewahren)
  - Discord-Feedback bei Erfolg/Fehler

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

- [ ] **`/config`** — WAKE_WORD, HISTORY_TURNS, TTS-Provider/Voice etc. via Discord-Command.
  - Permission-Check (Admin only?)
  - In-Memory-State + optionale JSON-Persistierung

- [ ] **`/sleep` / `/wake`** — niedrige Priorität (laut Diskussion).
  - Wake-Word vorübergehend deaktivieren (z. B. während privater Plauderei)
  - **Begründung für niedrige Prio**: Stop-Command unterbricht False-Positives bereits sehr gut; eigener Sleep-Modus ist nicht kritisch

- [ ] **`/debug on|off`** — Live-Debug-Output in einem Discord-Channel.
  - STT-Transkripte, Wake-Word-Treffer, LLM-Antworten, Latenz-/Buffer-Metriken
  - Server sendet über Control-Plane

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

- [ ] **`Pipecat TTS Service Spec`-konforme TTS-API** — Wartbarkeit/Ecosystem-Kompatibilität.

- [ ] **WebSocket-basiertes Piper-Streaming evaluieren** — `piper-streaming` oder `paroli` als Upgrade-Pfad falls Sub-100-ms-TTFA nötig wird. Aktuelle HTTP-Chunked-Lösung reicht aus.

- [ ] **Autostart via Windows Task Scheduler** — wird durch „Server-Auto-Start via SSH bei `/join`" weitgehend redundant. Falls noch gebraucht: `Start-VoiceAssistant.ps1 -Mode silent` als Aufgabe „bei PC-Entsperrung".

- [ ] **`package.json` Engine-Bump** — aktuell `node>=20`, benötigt aber 22.

---

## ✅ Done

- [x] **Piper TTS auf GPU (DirectML)** — bestätigt 1.93× Speedup auf AMD RX 6800 XT.
- [x] **Piper Streaming-API** — `POST /tts/synthesize` mit chunked HTTP-Streaming (Satz-für-Satz → niedrigere TTFA).
- [x] **TTS-Settings konfigurierbar** — `length_scale`, `noise_scale`, `noise_w_scale` per Request; Voice-Wechsel per `model`-Feld.

---

## Verworfen

- **Mehrere gleichzeitige Sessions** — Bot ist bewusst auf einen Voice-Channel beschränkt.
- **`/redact`-Command** — würde LLM-Entscheidungen erfordern. Off-Topic-Filter passiert manuell oder in der externen Cowork-Pipeline.
- **`/marker`-Command** — gleiches Argument; Anker im Transkript besser über Pause-Erkennung + Spielernotizen.
- **Live-Stitching der Monolog-Unterbrechungen** — zu komplex; nur im Finalize-Pfad gelöst (Live-Log darf chronologisch leicht falsch sein).
- **Aufholen-während-Live-Modus** (Server kommt mitten in der Session dazu und verarbeitet Backlog parallel) — eine GPU, Konflikt mit Live-Last; stattdessen klare Zustände Online-Live / Offline-Cache / Finalize.
