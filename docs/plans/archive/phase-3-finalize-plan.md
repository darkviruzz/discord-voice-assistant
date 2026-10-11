# Phase 3 — Finalize-Pipeline · Implementierungsplan

> Arbeitsbranch: `claude/phase-3-features-fixes-QxtBs`
> Ziel: vom rohen Audio + JSONL-Log zum lesbaren, chronologisch korrekten Markdown-Transkript.
> Versionsziel am Phasenende: `1.3.0`.

## Status (umgesetzt)

- [x] **M0** schemaVersion v2, Whisper-Wort-Timestamps, Clock-Offset über Control-WS
- [x] **M1** Lifecycle: `/leave` beendet nicht, `/join` re-attacht, Status open→finalizing→finalized
- [x] **M2** Merge-Modul (`finalize/merge.js`) + CLI + 13 Fixture-Tests
- [x] **M3** Persistente Speaker-Map + `/finalize map` + Live-Reminder
- [x] **M4** `/finalize run|list|show` + Server-Orchestrator (re-STT, Archiv, Checksum-Ack)
- [x] **M5** OGG/Opus-Audio-Archiv (merged + per-Äußerung) + Upload-Cleanup
- [x] **M6** Server-seitiger Auto-Finalize-Idle-Timer + Race-Handling
- Tests: `npm test` → 29 Unit-Tests grün. Integration: `docs/phase-3-manual-tests.md`.

## Architektur (final entschieden)

**Rollen**
- **Bot** = Aufnahme (per-User-WAV, einzige *lückenlose* Audio-Quelle) + Offline-Insurance.
  Bot-Daten sind **primary source** für alles, was aus Audio+Timestamps rekonstruierbar ist.
- **Server** = Single Source of Truth für **Events** (JSONL) + **Finalize-Instanz** + **Langzeit-Archiv**.
  Hält Live-Audio nur **RAM-transient** für Live-STT (verwirft es danach). **Keine** Live-Server-WAV
  (Baseline), **keine** Text-Replikation zum Bot.

**Datenfluss live**
- Bot: Discord-Opus → (a) lokale WAV (persistent), (b) Passthrough an `/uplink`.
- Server: Opus-Frames im RAM → dekodiert pro Utterance → Live-STT → JSONL (`user_transcript`,
  `wakeword_query`, `assistant_response`, `tts_*`, `stop_command`, `playback_*`) → Audio verworfen.
- Server-offline mid-session ist **egal** für Finalize: ab dem Offline-Event fehlt nur die
  Live-Unterstützung (LLM/Wake/Live-STT); Audio+Timestamps liegen lückenlos beim Bot.

**Uhren / Clock-Sync** (Bot-Uhr ist maßgeblich)
- Offset passiv über Control-WS messen (NTP-Stil): beim `hello` + periodisch (~60 s) geglättet
  als `clockOffsetMs` ins `session_meta`/JSONL schreiben. Bei Finalize Server-Timestamps auf die
  Bot-Timeline normalisieren. Keine aktive Uhrkorrektur, kein externer Timeserver.

**Finalize-Flow**
1. Bot scp't alle WAVs + Timeline zum Server (Bulk-Pfad). Server kann beginnen, sobald erste
   WAVs da sind (streaming).
2. Server **re-transkribiert authoritativ aus den WAVs** (liefert Token-Timestamps, lückenlos);
   JSONL liefert nur die **Nicht-Audio-Events** (Wake/Assistant/TTS/Stop/Pause) als Overlay.
3. Merge → `transcripts/<datum>-<id>/transcript.md`.
4. Audio-Archiv (OGG/Opus 32 kbps) + JSONL + `session_meta` + Speaker-Map-Snapshot ins
   server-seitige Session-Storage = Re-Finalize-Vertrag.
5. **Ack mit Checksum** (pro Datei, z. B. SHA-256): Bot löscht erst nach bestätigtem,
   durably geschriebenem Archiv. Default: Retention/Verschieben statt sofort `rm`.

**Idempotenz / Forward-Compat**
- Finalize = reiner Rebuild aus Archiv (Audio + JSONL + meta). Mit neuem Code wiederholbar.
- `schemaVersion` in den Events; fehlende (später hinzugekommene) Felder → sinnvolle Fallbacks
  (z. B. keine Token-Timestamps → Utterance-genaues Splitting).

## Getroffene Entscheidungen (User)

1. Token-Timestamps zuerst nachrüsten; Merge wort-genau, sonst Utterance-Fallback.
2. `/save-session` → `/finalize` (Top-Level, Subcommands `run`/`list`/`show`).
3. `/finalize` end-to-end als erste dünne Slice, dann vertiefen.
4. In dieser Runde: Audio-Archiv + Cleanup, Speaker-Mapping, Auto-Finalize-Timer.
   (LLM-Summary **nicht** in dieser Runde.)
5. Finalize re-transkribiert authoritativ aus WAVs (JSONL = Overlay-Events).
6. Keine Text-Replikation zum Bot (minimal nötige Daten gehen eh hin; Web-UI später).
7. Bulk-Audio-Upload via **scp/SSH** (Re-use `SERVER_START_CMD`-Setup).
8. Keine Live-Server-WAV in der Baseline; Coverage-Abgleich-Optimierung später.

## Milestones

### M0 — Fundament & Forward-Compat
- **M0.1** `schemaVersion` in JSONL-Events; Fallback-Strategie dokumentiert.
- **M0.2** Whisper-Wort/Token-Timestamps in `stt.js` aktivieren + ins `user_transcript`
  (`words:[{w,t0,t1}]`); fehlt → Utterance-Fallback im Merge.
- **M0.3** Clock-Offset-Messung über Control-WS (NTP-Stil), `clockOffsetMs` ins `session_meta`/JSONL.

### M1 — Session-Lifecycle-Refactor
- `/leave` → nur Voice-Disconnect, **kein** `sessionEnd` (heute fälschlich in `index.js:296`).
- `/join` → innerhalb Idle-Fenster an offene Session **re-attachen** (gleiche `sessionId`/`dir`),
  sonst neue. Explizites Resume-Signal auf der Control-Plane statt „new vs end".
- Session-Status: `open` → `finalizing` → `finalized` (+ `finalizedAt`, `finalizeVersion`).

### M2 — Transkript-Merge-Modul (Kern)
- Reines Modul `apps/server/src/finalize/merge.js`: `buildTranscript(events, words, opts) → markdown`.
- Absolut-Timestamps (Bot-Timeline, Offset-normalisiert); chronologische Sortierung;
  Monolog-Splitting an Token-Grenzen (`*[X unterbricht]*`/`*[X weiter]*`); Pause-Header bei
  >30 s (`PAUSE_THRESHOLD_S`); Wake/Stop **fett**; Assistant als eigener Sprecher.
- Token-Timestamps optional → Utterance-Fallback. Speaker-Mapping anwenden (M3).
- **CLI** `scripts/build-transcript.mjs <session.jsonl> [wavs/]` für Offline-Rebuild.
- **Fixture-Tests**: Überlappung, Split, Pause, Wake/Stop, fehlende Token-Daten,
  Online→Offline-Naht (Span mit Events + Span nur Audio).

### M3 — Speaker-Mapping (Discord, persistent)
- Persistenter Store `data/speaker-map.json` (per Guild): Discord-ID → `{player, character, phonetic}`.
- **Live-Reminder**: ephemeral an den `/join`-User, sobald ein Speaker **ohne** Mapping im Channel
  ist/dazukommt (Erinnerung). Nicht gemappt → Default = Display-Name.
- **Interaktives Mapping** beim manuellen `/finalize run` (Select/Modal). Auto-Finalize promptet nie.
- Map-Snapshot wandert ins Archiv.

### M4 — `/finalize`-Command & Flow (erste end-to-end Slice)
- Subcommands: `/finalize run [session:<id>]`, `/finalize list`, `/finalize show <id>`.
- Flow: scp-Upload → (re-)STT aus WAV → Merge → transcript.md → Archiv → Ack/Checksum → Cleanup
  → Discord-Feedback. Async (defer + Progress).
- Erste Slice: dünn end-to-end (Utterance-Merge + bestehender Audio-Mix), dann vertiefen.
- `npm run register` nach Command-Änderung.

### M5 — Audio-Archiv & Cleanup
- OGG/Opus 32 kbps (gemerged + optional pro Sprecher); `mixer.js` erweitern/wiederverwenden.
- WAV-Cleanup nur nach **Checksum-bestätigtem** Archiv; `ARCHIVE_RETENTION` (move vs delete),
  Default verschieben/Retention statt `rm`.

### M6 — Auto-Finalize-Timer (server-seitig)
- **Timer läuft auf dem Server** (= Finalize-Instanz). Bedingung: 4 h nach **letzter Aktivität**,
  wobei „Aktivität" = Spieler im Voice-Channel anwesend; Start des Countdowns wenn Bot **allein**
  im Channel **oder** nach `/leave` (reine Stille bei Anwesenheit zählt **nicht**). Konfigurierbar.
- Bot meldet Voice-State (allein/besetzt, leave/join) per Control-Event an den Server.
- **Race-Condition** abfangen: `open → finalizing` atomar; `/join` während `open` resettet Timer;
  trifft Join auf bereits `finalizing` → neue Session.
- Server offline → keine Auto-Finalize; Discord-Hinweis „manuell finalisieren".

### Später / nicht in dieser Runde
- **Live-Server-Aufnahme + Coverage-Abgleich** (Transfer-Optimierung: online-Sessions laden kaum
  hoch; Bot-WAV bleibt Referenz, Abgleich über Zeit-Coverage nicht Byte-Identität).
- LLM-Summary-Block.

## Reihenfolge
M0 → M1 → M2 (+CLI/Tests) → M4-Slice (end-to-end dünn) → M3 → M5 → M6 → Doku/Bump `1.3.0`.
