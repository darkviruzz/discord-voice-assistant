# Live-Transkript-Kontext — Manuelle Online-Test-Checkliste

Diese Checkliste deckt das Live-Transkript-/Rolling-Summary-/Kampagnen-Kontext-
Feature (M0–M6) end-to-end mit echtem Bot + Server + Whisper/Ollama/Piper ab.
Die reinen Helfer (Render, Fold-Auswahl, Truncation, Cache) sind bereits durch
Unit-Tests abgedeckt (`npm test`, 55 Tests) — hier geht es um das Verhalten im
laufenden Gespräch, das nur live prüfbar ist.

> Schnell-Smoke-Test ohne Discord: siehe Abschnitt 8 (curl gegen Ollama-Pfad
> über eine Text-Query).

## 0. Vorbereitung / Konfiguration

**Server (`apps/server/.env`):**
- [ ] `LIVE_CONTEXT_ENABLED=true` (Default). Mit `false` muss sich der Server
      exakt wie vorher verhalten (Regressions-Gegenprobe, siehe Abschnitt 7).
- [ ] `OBSIDIAN_VAULT_PATH` zeigt auf den Vault **oder** `CAMPAIGN_CONTEXT_FILE`
      ist ein absoluter Pfad. Relativer Pfad ohne Vault → Kampagnen-Block bleibt
      stillschweigend leer (das ist gewollt, aber dann ungetestet).
- [ ] `CAMPAIGN.md` existiert am erwarteten Ort und enthält echten Inhalt
      (per Cowork-Skill `campaign-context-generieren` erzeugt).
- [ ] Schwellen gesetzt/Default akzeptiert: `LIVE_RAW_WINDOW_CHARS=6000`,
      `LIVE_FOLD_CHARS=3000`, `LIVE_RENDER_MAX_CHARS=6000`,
      `SUMMARY_MAX_CHARS=2000`, `CAMPAIGN_CONTEXT_MAX_CHARS=6000`.
- [ ] `SUMMARY_MODEL` leer (= `OLLAMA_MODEL`) **oder** ein kleineres/schnelleres
      Modell gesetzt und mit `ollama pull` geladen.
- [ ] Speaker-Map gepflegt (`/finalize map …`), damit die Live-Zeilen sinnvolle
      Labels tragen (`Hauke (Thrain)` statt nackter Discord-ID).
- [ ] Whisper/Ollama/Piper laufen wie gehabt.

**Kontext-Budget vorab abschätzen (wichtig, siehe „Vor dem Go-Live"):**
- [ ] Modell-Kontextfenster ≥ Summe der Blöcke. Worst Case ≈ Kampagne (6000) +
      Summary (2000) + Live (6000) + `HISTORY_TURNS`·~Antwortlänge + System-Prompt
      ≈ 14–16k Zeichen ≈ ~4–5k Token **nur Eingabe**. Bei einem 8k-Token-Modell
      passt das, aber knapp — ggf. `num_ctx` in Ollama / Schwellen senken.

## 1. Live-Transkript wird injiziert (alle Sprecher)

- [ ] `/join`, zwei verschiedene Personen sprechen **ohne** Wake-Word ein paar
      Sätze (z. B. „Wir gehen nach Norden.", „Ich behalte die Tür im Auge.").
- [ ] Danach **eine** Wake-Word-Frage stellen, die sich auf das eben Gesagte
      bezieht: „Rabenauge, was hat die Gruppe gerade vor?"
- [ ] Antwort referenziert das vorherige Gespräch (nicht nur die letzte Frage) →
      beweist, dass alle Utterances (nicht nur Wake-Word-Queries) im Puffer sind.
- [ ] Server mit `DEBUG=1`: Log zeigt `liveContext: loaded …` (Kampagne) und das
      Transkript ist im Prompt. (Optional: temporär die `messages` in `chat()`
      loggen, um die drei `system`-Blöcke zu sehen.)

## 2. Kampagnen-Kontext (Variante A)

- [ ] Eine Frage zu einem Eigennamen aus `CAMPAIGN.md` stellen, der **noch nicht**
      im Gespräch vorkam (z. B. ein NSC). Antwort nutzt das Wissen aus der Datei.
- [ ] `CAMPAIGN.md` **während laufender Session** editieren und speichern →
      nächste Frage nutzt den neuen Inhalt (mtime-Cache, kein Server-Restart).
- [ ] Datei wegnehmen/umbenennen → nächste Frage funktioniert weiter (Block fällt
      leer aus), kein Crash.

## 3. Rolling-Summary-Fold

- [ ] Lange genug reden, bis der rohe Puffer `LIVE_RAW_WINDOW_CHARS` überschreitet
      (zum Testen `LIVE_RAW_WINDOW_CHARS=800`, `LIVE_FOLD_CHARS=400` setzen).
- [ ] Server-Log (`DEBUG=1`): `rollingSummary: folded N entries → summary … chars`.
- [ ] Eine Frage zu etwas, das **vor** dem Fold gesagt wurde → Antwort kennt es
      noch (steht jetzt in der Zusammenfassung, nicht mehr im Roh-Puffer).
- [ ] Single-Flight: schnell mehrere Utterances hintereinander → es läuft nie mehr
      als ein Fold gleichzeitig (kein doppeltes „folded …" mit überlappenden
      Segmenten; `lc.summarizing`-Guard).
- [ ] Crash-Sicherheit: Ollama kurz stoppen, während ein Fold fällig wäre →
      Log `fold failed (segment kept)`, der Puffer behält die Einträge, nächster
      Versuch faltet erneut (kein Datenverlust).
- [ ] Optional Drosselung: `LIVE_FOLD_MIN_INTERVAL_MS=30000` → Folds liegen ≥ 30 s
      auseinander.

## 4. Resume-Rebuild aus dem JSONL

- [ ] Eine Session mit ein paar Turns aufnehmen (`/join`, sprechen, Fragen).
- [ ] **Server neu starten** (RAM-Puffer ist weg), dann `/join` (Resume, gleiche
      Session-ID innerhalb `SESSION_IDLE_HOURS`).
- [ ] Server-Log: `rollingSummary: rebuilt sid=… buffer=… entries, summary=… chars`.
- [ ] Erste Wake-Word-Frage nach dem Resume kennt den Verlauf von vor dem Neustart
      (jüngste Turns als Roh-Puffer, ältere in der Zusammenfassung).
- [ ] Rebuild läuft genau **einmal** pro Session (`lc.rebuilt`-Flag): zweites
      `/join` derselben Session baut nicht erneut.

## 5. Assistant-Antworten landen im Puffer

- [ ] Frage stellen, Antwort abwarten. Danach Folgefrage „Was hast du gerade
      gesagt?" → Antwort bezieht sich auf die vorige Assistant-Antwort, weil diese
      als `[Rabenauge] …`-Zeile im Live-Puffer steht.

## 6. Telemetrie im `session_meta`

- [ ] Im Session-JSONL enthält das `session_meta`-Event einen `liveContext`-Block
      mit `enabled`, `rawWindowChars`, `foldChars`, `renderMaxChars`,
      `summaryModel`, `summaryMaxChars`, `campaignContextFile`,
      `campaignContextMaxChars` — Werte = aktuelle `.env`.

## 7. Feature-Flag aus (Regressions-Gegenprobe)

- [ ] `LIVE_CONTEXT_ENABLED=false`, Server neu starten.
- [ ] `/join`, sprechen, Wake-Word-Frage → Antwort nutzt **nur** den klassischen
      `HISTORY_TURNS`-Verlauf; kein Live-Block, kein Kampagnen-Block, kein Fold.
- [ ] Server-Log zeigt keine `rollingSummary:`-/`liveContext: loaded`-Zeilen.
- [ ] `session_meta.liveContext.enabled = false`.

## 8. Schnell-Smoke ohne Discord (Text-Query-Pfad)

> Greift NICHT auf den Live-Puffer zu (der existiert nur für Voice-Sessions),
> prüft aber, dass `chat()` mit `systemBlocks` weiterhin sauber antwortet und der
> Kampagnen-Block bei einer aktiven Voice-Session mitgegeben wird.

- [ ] Bei aktiver Voice-Session über `/ask "Frage"` (oder `text_query`) fragen →
      Antwort kommt, Kampagnen-Kontext greift, keine Exceptions im Server-Log.

---

## Bekannte Grenzen / worauf besonders zu achten ist

- **Eine GPU, ein Modell**: Der Fold-Call und der Antwort-Call teilen sich dieselbe
  Ollama-Instanz. Faltet der Server mitten in der Runde, kann das die Antwort-/
  TTS-Latenz kurz erhöhen. Gegenmaßnahmen: `LIVE_RAW_WINDOW_CHARS` groß genug
  (selteneres Folden), `LIVE_FOLD_MIN_INTERVAL_MS` setzen, oder ein kleines
  `SUMMARY_MODEL`. Während einer realen Session beobachten, ob Antworten stocken.
- **Kontext-Überlauf**: Zu großzügige Schwellen können das Kontextfenster sprengen
  → das Modell „vergisst" den System-Prompt oder antwortet wirr. Erst mit den
  Defaults fahren, dann vorsichtig erhöhen.
- **Qualität der Zusammenfassung**: Das lokale Modell kann beim Zusammenfassen
  Eigennamen verfälschen. Nach langen Sessions die `summary` (im RAM, via Debug-
  Log) stichprobenartig prüfen; ggf. `SUMMARY_SYSTEM`-Prompt schärfen.
- **`CAMPAIGN.md`-Inhalt**: Kein DM-Geheimwissen, Eigennamen exakt, ≤ ~5500 Zeichen.
  Inhalt ist nur so gut wie die per Cowork erzeugte Datei.
- **Out-of-order STT**: Utterances werden nach `startMs` einsortiert; bei stark
  verzögerter STT kann eine Live-Zeile dennoch leicht falsch einsortiert sein
  (Live-Log darf chronologisch minimal abweichen — wie beim Finalize-Pfad).
