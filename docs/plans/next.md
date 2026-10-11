# Aktueller Plan (Stand Oktober 2026)

Einzige aktive Plan-Datei. Erledigte Pläne liegen in [`archive/`](archive/),
Betriebswissen in [`../ops-notes.md`](../ops-notes.md), das Backlog in
[`../../TODO.md`](../../TODO.md).

## Stand

PR #18 (`claude/rag-integration-orchestration-inmqox`) bündelt alles seit
v2.0.0. Produktiv läuft noch v2.0.0 von `main`; der PR wird erst nach dem
Live-Test gemergt.

- Vault-RAG im Node-Server (kein Python-Dienst mehr), Recap auf Nachfrage
  (`/recap`, letzte Session-Zusammenfassung als Kontext) statt /join-Briefing.
- Provider-Schicht: STT/TTS/LLM/Embeddings wahlweise lokal (whisper.cpp,
  Piper, Ollama) oder über OpenAI-kompatible Server — siehe
  [`../providers.md`](../providers.md).
- Finalize: übersteht Verbindungsabbrüche, Auto-Finalize nach `/leave` im Bot,
  Fortschritt + Ergebnis als Discord-Statusnachricht, Session-Zusammenfassung.
- Windows-Server: `scripts/Setup-VoiceAssistant.ps1` (Einrichtung + `-Check`),
  keine fest verdrahteten Pfade, Launcher folgt der Provider-Wahl.
- Sicherheit: Shell-Kommandos/Server-URLs nicht mehr übers Web-Panel
  änderbar, `/downlink` + `/shutdown` geschützt, Path-Traversal-Fixes.
- STT-Benchmark `npm run bench:stt` (WER + Namen-Recall an eigenen Aufnahmen).

## Live-Test vor dem Merge (Reihenfolge)

1. **Windows-PC:** `git fetch && git checkout claude/rag-integration-orchestration-inmqox`,
   `npm ci`, dann `.\scripts\Setup-VoiceAssistant.ps1` (fragt Vault-Pfad,
   prüft whisper/Piper/Ollama, lädt bei Bedarf `nomic-embed-text`). Danach
   `-Check` muss grün sein, `.\scripts\Start-VoiceAssistant.ps1` starten.
   Erster Start indiziert den Vault einmal komplett (Log: `rag: …`).
2. **Bot-Host:** Branch auschecken, `npm ci --omit=dev`, `npm run register`
   (neuer Befehl `/recap`), `sudo systemctl restart discord-bot`.
3. **Session-Test:** `/join`, kurz sprechen, `/leave`, `/finalize run` →
   Statusnachricht im Kanal muss Fortschritt zeigen und mit Ergebnis +
   Zusammenfassung enden. Danach `/recap`.
4. **Lange Session / Abbruch:** während eines Finalize den Server-Link kappen
   (z. B. Server-Prozess kurz stoppen) → Statusnachricht meldet Unterbrechung,
   Finalize läuft nach Reconnect weiter bzw. meldet den Fehler sichtbar.
5. **Auto-Finalize:** `SESSION_IDLE_HOURS` testweise klein setzen (z. B. 0.05),
   `/leave` → Session finalisiert sich selbst, Meldung im Kanal.
6. **Cloud (optional, `--slot test`):** Finalize-Matrix aus dem archivierten
   GPU-Plan (Punkte 4–9) — Upload per HTTP, Archiv-Pull nach `~/archive/`.

## Offene Punkte / Entscheidungen

- **DATA_DIR des Bots** liegt laut Betriebsnotizen auf `/tmp/voice-sessions`
  — `/tmp` wird beim Reboot geleert: noch nicht finalisierte Aufnahmen und die
  Panel-Overrides (`config.overrides.json`) gingen verloren. Empfehlung:
  persistenter Pfad (z. B. `/var/lib/discord-bot/sessions`, dem `discordbot`
  gehörend).
- **Rabenauge-Antwortqualität/Latenz:** `llama3.2` (3B) ist für Kampagnen-
  Fragen zu schwach. Auf der RX 6800 XT (16 GB) passen z. B. Qwen3 14B /
  Gemma 3 12B (Q4) neben whisper + Piper; per Benchmark/Live-Test
  entscheiden. Latenz-Hebel danach: LLM-Antwort streamen und TTS ab dem
  ersten Satz starten (heute wird die komplette JSON-Antwort abgewartet).
- **STT-Modell:** `ggml-medium-q5_0` → `large-v3-turbo` testen (Setup bietet
  den Download an); mit echten Aufnahmen per `bench:stt` vergleichen.
- **Voice-Clone für Rabenauge:** offen (Owner).
- **Lizenz** des öffentlichen Repos: offen (Owner).

## Später (Phasen)

- **C — Realtime-STT:** Streaming-Provider (z. B. Voxtral Realtime über
  vLLM `/v1/realtime`) statt LocalAgreement-Re-Transkription; nur sinnvoll
  auf CUDA (Cloud) — die RX 6800 XT hat dafür keinen Weg unter Windows.
- **Windows-Konsolidierung:** AMD Lemonade als ein Server für LLM + STT +
  Embeddings testen (Piper bleibt fürs Deutsche) — reine Konfiguration.
- **Piper:** DirectML ist im Maintenance-Modus; Migration auf Windows ML
  (ONNX Runtime) wenn nötig.
