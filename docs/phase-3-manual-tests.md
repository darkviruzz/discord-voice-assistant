# Phase 3 — Manuelle Online-Test-Checkliste

Diese Checkliste deckt die Finalize-Pipeline (M0–M6) end-to-end mit echtem Bot +
Server + Whisper/Ollama/Piper ab. Die reine Merge-/Orchestrator-Logik ist bereits
durch Unit-Tests abgedeckt (`npm test`, 29 Tests) — hier geht es um die Integration,
die nur live prüfbar ist.

> Tipp: für die Auto-Finalize-Tests `SESSION_IDLE_HOURS` temporär klein setzen
> (z. B. `0.02` ≈ ~72 s), danach zurück auf `4`.

## 0. Vorbereitung / Konfiguration

**Server (`apps/server/.env`):**
- [ ] `FINALIZE_UPLOAD_DIR` gesetzt (Default `./uploads`) — Ziel der Bot-Uploads.
- [ ] `ARCHIVE_DIR` gesetzt (Default `./archive`).
- [ ] `SPEAKER_MAP_FILE` gesetzt (Default `./data/speaker-map.json`).
- [ ] `ffmpeg` im PATH des Servers (für OGG-Archiv; sonst Fallback = WAV-Kopie).
- [ ] `WHISPER_WORD_TIMESTAMPS=true` (für wortgenaues Interrupt-Splitting).
- [ ] Whisper/Ollama/Piper laufen wie gehabt.

**Bot (`apps/bot/.env`):**
- [ ] `FINALIZE_UPLOAD_CMD` als scp-Template gesetzt, z. B.
      `scp -i ~/.ssh/id_ed25519_va -o BatchMode=yes -r {src}/. nogar@HOST:C:/.../apps/server/uploads/{sessionId}/`
      (muss die WAVs **inkl. manifest.json** nach `<FINALIZE_UPLOAD_DIR>/<sessionId>/` legen).
      Leer lassen nur, wenn Bot & Server dasselbe Dateisystem sehen.
- [ ] `ARCHIVE_RETENTION=move` (oder `delete`).
- [ ] `SERVER_BASE_URL` / `CONTROL_BEARER` wie gehabt.

**Commands registrieren** (Schema hat sich geändert: `/save-session` → `/finalize`):
- [ ] `npm run register` ausgeführt; in Discord erscheinen `/finalize run|list|show|map`.

## 1. Session-Lifecycle (M1)

- [ ] `/join` im Voice-Channel → „neue Session …". Sprechen → im Server-Log
      `user_transcript`-Events.
- [ ] `/leave` → Antwort sagt „Session bleibt offen". Server-Log: `voice_state left`.
- [ ] `/join` erneut (innerhalb Idle-Fenster) → „Session **fortgesetzt** (gleiche ID)".
- [ ] Bot neu starten, dann `/join` → setzt die offene Session von Platte fort
      (gleiche ID), sofern innerhalb `SESSION_IDLE_HOURS`.

## 2. Speaker-Mapping (M3)

- [ ] `/finalize map user:@Spieler player:Hauke character:Thrain` → „Zuordnung gespeichert".
- [ ] `/finalize map` (ohne Argument) → listet die Zuordnungen.
- [ ] `/join` mit einem noch nicht gemappten Sprecher im Channel → ephemerale
      Erinnerung „Ohne Sprecher-Zuordnung: …".
- [ ] Server-Datei `data/speaker-map.json` enthält die Zuordnung (pro Guild).

## 3. Manuelles Finalize (M2 + M4 + M5)

Eine kurze Session aufnehmen (mehrere Sprecher, Wake-Word „Rabenauge …", ggf. „stop"),
dann:
- [ ] `/finalize run` → Fortschritt „Lade … hoch" → „Server transkribiert …" → ✅.
- [ ] Antwort nennt Transkript-Pfad + Audio-Archiv-Pfad + Spuren-Anzahl.
- [ ] **Transkript** (`<TRANSCRIPT_DIR>/<datum>-<id>/transcript.md`) prüfen:
  - [ ] Kopf mit Datum/Channel/Teilnehmern/Dauer.
  - [ ] Chronologische Reihenfolge, Zeitstempel `[HH:MM:SS]`.
  - [ ] Sprecher-Labels = Mapping (`Hauke (Thrain)`), sonst Anzeigename.
  - [ ] Wake-Word + Stop-Wörter **fett**.
  - [ ] Assistant-Antworten als eigener Sprecher `**Rabenauge:**`.
  - [ ] Pausen > 30 s → `## HH:MM — Pause (N min)`.
- [ ] **Archiv** (`<ARCHIVE_DIR>/<datum>-<id>/`) enthält: `transcript.md`,
      `session.jsonl`, `manifest.json`, `speaker-map.json`, `audio/` mit
      `session_mix.ogg` + Per-Äußerung-`*.ogg` + `index.json`.
- [ ] **Retention**: lokale Bot-WAVs nach `<DATA_DIR>/_archived/<id>/chunks/`
      verschoben (bei `move`) bzw. gelöscht (bei `delete`).
- [ ] **Server-Upload-Cleanup**: `<FINALIZE_UPLOAD_DIR>/<sessionId>/` ist nach
      erfolgreichem Finalize entfernt (außer `FINALIZE_KEEP_UPLOADS=true`).
- [ ] `/finalize list` zeigt die Session als `finalized`; `/finalize show <id>`
      nennt Transkript-/Archiv-Pfad.

## 4. Wortgenaues Interrupt-Splitting (M0.2 + M2)

- [ ] Zwei Personen bewusst überlappend sprechen (A langer Satz, B fällt ins Wort).
- [ ] Nach `/finalize run`: im Transkript ist A an der Unterbrechungsstelle
      gesplittet, B trägt `_[unterbricht]_`, A’s Fortsetzung `_[weiter]_`.
- [ ] Hinweis: hängt von Whisper-Wort-Timestamps ab. Fehlen sie (älterer
      whisper.cpp-Build), bleibt die Äußerung ungesplittet (Utterance-Fallback) —
      das ist erwartetes Verhalten. Im JSONL prüfen, ob `user_transcript.words`
      gefüllt ist.

## 5. Server offline mitten in der Session (Offline-Insurance)

- [ ] Während aktiver Session den Server stoppen. Weiter sprechen (Bot nimmt
      lokal weiter auf; keine Live-STT/LLM).
- [ ] Server wieder starten, ggf. `/join` (resume).
- [ ] `/finalize run` → das Transkript enthält **auch** die offline gesprochenen
      Passagen (aus den Bot-WAVs re-transkribiert), nur ohne Assistant-Overlay
      für die Offline-Phase.

## 6. Auto-Finalize (M6)

`SESSION_IDLE_HOURS` klein setzen (z. B. `0.02`), Server neu starten.
- [ ] `/join`, kurz sprechen, dann **alle** Menschen verlassen den Channel
      (Bot bleibt allein) → Server-Log `voice_state alone`, Timer armiert.
- [ ] Nach Ablauf: Server-Log „idle timeout … requesting finalize"; Bot führt
      Finalize aus; Notiz im Text-Channel „automatisch finalisiert".
- [ ] Gegenprobe Race: armieren lassen, dann **vor** Ablauf wieder joinen →
      `voice_state occupied`, Timer abgebrochen, **kein** Auto-Finalize.
- [ ] `/leave`-Variante: nach `/leave` (statt Channel-Verlassen) armiert der Timer
      ebenfalls.
- [ ] Reine Stille bei anwesenden Spielern löst **kein** Auto-Finalize aus.

## 7. Clock-Sync (M0.3)

- [ ] Im Session-JSONL erscheinen periodisch `clock_sync`-Events mit `offsetMs`.
- [ ] Bei großer absichtlicher Uhr-Differenz zwischen Bot- und Server-Host: die
      Assistant-Zeilen im Transkript liegen trotzdem korrekt relativ zu den
      Sprecher-Zeilen (Normalisierung über den Offset).

## 8. Checksum-Gate (M4)

- [ ] Upload künstlich stören (eine WAV im Upload-Ordner nach dem scp verändern,
      oder eine löschen) und `/finalize run` erneut.
- [ ] Antwort meldet „⚠️ N fehlende / M fehlerhafte Uploads"; **lokale WAVs
      bleiben erhalten** (keine Retention), das Transkript enthält nur die
      verifizierten Äußerungen.

## 9. CLI-Offline-Rebuild (M2)

- [ ] `npm run transcript -- <pfad>/session_<id>.jsonl --tz Europe/Berlin`
      erzeugt ein Transkript aus dem JSONL (Live-Text-Pfad) — nützlich für alte
      Sessions / Debug.

---

## Bekannte Grenzen / Folgearbeiten

- **Whisper-Wort-Timestamps**: abhängig vom whisper.cpp-Build. Ohne sie greift
  der Utterance-Fallback (kein wortgenaues Splitting).
- **Re-Finalize**: `/finalize run session:<id>` funktioniert auch für bereits
  finalisierte Sessions — der Bot lädt die ins `_archived/<id>/chunks/`
  verschobenen WAVs erneut hoch (Retention `move`). Bei Retention `delete` gibt
  es keine lokale Quelle mehr; ein Re-STT direkt aus den Archiv-OGGs des Servers
  (OGG→PCM-Decode) ist noch nicht verdrahtet.
- **Server-Restart während des Idle-Fensters**: der In-Memory-Timer geht verloren.
  Der Bot flaggt solche Sessions beim Start im Log; Abschluss dann via
  `/finalize run`. (Timer-Persistenz = Folgearbeit.)
- **Live-Server-Mitschnitt + Coverage-Abgleich** (Transfer-Optimierung) bewusst
  nicht enthalten — Baseline lädt bei Finalize immer hoch.
- **LLM-Summary** bei Finalize: nicht in dieser Runde.
