# Aktueller Plan (Stand Oktober 2026)

Einzige aktive Plan-Datei. Erledigte Pläne liegen in [`archive/`](archive/),
Betriebswissen in [`../ops-notes.md`](../ops-notes.md), das Backlog in
[`../../TODO.md`](../../TODO.md).

## Stand

`main` = v2.2.0 (`9134d70`): PR #18 (v2.1, gemergt 2026-10-19) und PR #19
(v2.2, gemergt 2026-10-20) sind drin, Tags `v2.1.0` und `v2.2.0` gesetzt.
Windows-Server und Bot laufen auf `main`. Der Live-Test vor dem Merge von
PR #18 ist erledigt ([`archive/live-test-v2.1.md`](archive/live-test-v2.1.md)).

- **v2.1 (PR #18):** Vault-RAG im Node-Server, `/recap`; Provider-Schicht
  lokal oder OpenAI-kompatibel ([`../providers.md`](../providers.md));
  Finalize übersteht Abbrüche, meldet sich per Discord-Statusnachricht und
  schreibt eine Session-Zusammenfassung; Windows-Setup
  `scripts/Setup-VoiceAssistant.ps1`; Sicherheits-Fixes; `npm run bench:stt`.
- **v2.2 (PR #19):**
  - Konfiguration im Vault unter `99_Rabenauge/Konfiguration/`: vier
    Prompt-Notizen (`Prompt Persona.md`, `Prompt Sitzung Abschnitt.md`,
    `Prompt Sitzung Zusammenfassung.md`, `Prompt Live-Zusammenfassung.md`)
    plus `STT-Vokabular.md` und `STT-Korrekturen.md`. Der Ordner bleibt per
    `RAG_EXCLUDE` (`99_*/`) aus dem RAG-Index.
  - Session-Zusammenfassungen nur aus dem Spielgeschehen, mit Hintergrund
    (`CAMPAIGN.md` + vorige Session). Sie landen in
    `10_Campaign/Rabenauge-Zusammenfassungen/` und werden indiziert.
  - Antworten in ~6 s (vorher ~18 s) dank Prompt-Reihenfolge und Vorwärmen
    (`LLM_PRIME`); Regieanweisungen und Markdown fallen vor der
    Sprachausgabe weg.
  - `LAST_SESSION_CONTEXT_COUNT`: die N neuesten Session-Zusammenfassungen
    als Kontext.
  - Prompt-Budget: `LLM_PROMPT_BUDGET_CHARS=22000` bei 8192 Tokens Kontext
    (`docs/providers.md`, „Prompt-Budget“).
- **Archiv aufgefrischt (2026-10-20):** JK39–JK43 mit dem Vokabular neu
  finalisiert, Namensfehler 443 → 75. Die Zusammenfassung von JK44 ist neu
  erzeugt.

## Offene Punkte / Später

### Vorgemerkt nach v2.2 (2026-10-20)

- **GWDG für die Zusammenfassungen** (`gemma-4-31B-it` über
  `chat-ai.academiccloud.de/v1`): geht ohne Codeänderung mit
  `SUMMARY_PROVIDER=openai`, `SUMMARY_BASE_URL`, `SUMMARY_API_KEY`,
  `SUMMARY_MODEL`. Vorher `bench:llm` (nächster Punkt).
  - Dateien: `docs/providers.md` („Eigener Server für die
    Zusammenfassungen“), `apps/server/src/providers/llm.js`.
  - Datenschutz: Die Transkripte der Spieler verlassen dann das Haus.
- **Später: `bench:llm` gegen GWDG** (vorgemerkt 2026-10-19, nicht jetzt).
  - Echte Archiv-Prompts (Weckwort-Fragen mit RAG- und Live-Kontext, 1–2
    Session-Transkripte mit einer Faktenliste) gegen lokal `gemma4:12b` und
    GWDG (`chat-ai.academiccloud.de/v1`) laufen lassen: `gemma-4-31B-it`,
    Qwen3.8-27B.
  - Messen: Latenz, JSON-Gültigkeit, Faktentreffer und Fehlbehauptungen.
  - Danach entscheiden, ob Zusammenfassungen und/oder Antworten zur GWDG gehen
    (`SUMMARY_PROVIDER=openai` geht ohne Codeänderung).
  - Vorher klären: Nutzungsbedingungen (Forschung/Lehre) und Zustimmung der
    Runde; live bräuchte es einen Rückfall aufs lokale Modell.
- **Kontext auf 12288 Tokens erhöhen:**
  1. `OLLAMA_CONTEXT_LENGTH=12288` als Windows-Benutzervariable setzen (die
     8192 kommen heute aus den Einstellungen der Ollama-App), Ollama neu
     starten.
  2. In `%LOCALAPPDATA%\Ollama\server.log` VRAM und Offload prüfen.
  3. Dann `LLM_PROMPT_BUDGET_CHARS` auf ~33000 anheben und `HISTORY_TURNS` /
     `CAMPAIGN_CONTEXT_MAX_CHARS` lockern.
  - Dateien: `apps/server/src/promptBudget.js`, `docs/providers.md`
    („Prompt-Budget“ nennt noch 8192).
- **Leere Sessions ohne Zusammenfassung:** Eine Test-Session ohne Spielinhalt
  ergab „keine inhaltliche Zusammenfassung möglich … Ort: Crossford“ und eine
  Vault-Notiz. Finalize soll „kein Spielinhalt“ erkennen (Antwort des Modells
  oder Heuristik) und dann weder `summary.md` noch die Vault-Notiz schreiben.
  - Dateien: `apps/server/src/finalize/summary.js` (`summarizeSession`,
    `writeSummaryToVault`), `apps/server/src/finalize/index.js` (~Z. 215,
    `if (summary)`).
- **„Wondford“ klären:** steht 9× in den neuen Transkripten (24.08., 07.09.,
  12.10.), gemeint ist wohl „One Ford“, nicht „Crossford“. Mit dem Owner
  entscheiden, dann eine Regel in der Vault-Notiz `STT-Korrekturen.md`
  ergänzen. Ein Kommentar dort sagt, dass der Fall bewusst fehlt.
- **Test-Sessions aus dem Archiv räumen:** Jede finalisierte Test-Session wird
  zur „letzten Session“ (neueste `summary.md` in `apps/server/archive`). Danach
  mit `apps/server/transcripts/<id>` und der Vault-Notiz aus dem Archiv nehmen.
  Smoke-Tests vor dem Spiel besser nur per Text (`/ask`, `/recap`).

### Weitere offene Punkte

- **DATA_DIR des Bots** liegt laut Betriebsnotizen auf `/tmp/voice-sessions`
  — `/tmp` wird beim Reboot geleert: noch nicht finalisierte Aufnahmen und die
  Panel-Overrides (`config.overrides.json`) gingen verloren. Empfehlung:
  persistenter Pfad (z. B. `/var/lib/discord-bot/sessions`, dem `discordbot`
  gehörend).
- **Rabenauge-Antwortqualität/Latenz:** live läuft `gemma4:12b`.
  - Modellwahl am 2026-10-19 besprochen: lokal ist es das beste deutsche Modell
    bis 14B (EuroEval DE 2.01).
  - Prompt-Reihenfolge, Vorwärmen (`LLM_PRIME`) und JSON-Schema
    (`LLM_JSON_FORMAT`) sind umgesetzt. Damit dauert eine Antwort ~6 s statt
    ~18 s, siehe `docs/providers.md`.
  - Weitere Latenz-Hebel:
    - RAG-Budget (`CAMPAIGN_CONTEXT_MAX_CHARS`) verkleinern;
    - LLM-Antwort streamen und TTS ab dem ersten Satz starten (heute wird die
      komplette JSON-Antwort abgewartet).
- **STT-Modell:** `ggml-medium-q5_0` → `large-v3-turbo` testen (Setup bietet
  den Download an); mit echten Aufnahmen per `bench:stt` vergleichen.
- **Voice-Clone für Rabenauge:** offen (Owner).
- **Kleinkram aus dem Integrations-Review (bestehend, nicht blockierend):**
  getippte Fragen aus einem *anderen* Textkanal landen während einer
  Voice-Session in deren Verlauf (Bot und Server müssten die Session-ID pro
  Kanal mitführen); das Wake-Word des Bots (`WAKE_WORD`) schlägt beim
  Transkript ein im Panel gesetztes Server-Wake-Word; Code-Fallbacks
  `WHISPER_LANGUAGE`=auto / `WHISPER_TEMPERATURE`=0.2 weichen vom Katalog
  (de / 0.1) ab — wirkt nur ohne `.env`; der PowerShell-Env-Parser entfernt
  keine Inline-`# Kommentare` wie dotenv und ignoriert `DATA_DIR` für den
  Pfad der Panel-Overrides.
- **Lizenz** des öffentlichen Repos: offen (Owner).

## Später (Phasen)

- **C — Realtime-STT:** Streaming-Provider (z. B. Voxtral Realtime über
  vLLM `/v1/realtime`) statt LocalAgreement-Re-Transkription; nur sinnvoll
  auf CUDA (Cloud) — die RX 6800 XT hat dafür keinen Weg unter Windows.
- **Windows-Konsolidierung:** AMD Lemonade als ein Server für LLM + STT +
  Embeddings testen (Piper bleibt fürs Deutsche) — reine Konfiguration.
- **Piper:** DirectML ist im Maintenance-Modus; Migration auf Windows ML
  (ONNX Runtime) wenn nötig.
