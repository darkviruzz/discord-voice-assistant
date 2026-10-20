# Live-Test vor dem Merge von PR #18 (v2.1)

Erledigt: Der Live-Test lief durch, PR #18 wurde am 2026-10-19 als v2.1.0
gemergt. Diese Checkliste stand bis dahin in [`../next.md`](../next.md).

## Ablauf (Reihenfolge)

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
