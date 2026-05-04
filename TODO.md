# TODO & Ideen

Gesammelte Feature-Ideen und Verbesserungen. Kein Versprechen auf Umsetzung.

---

## Bot / Discord UX

- [ ] **LLM-Modell per Slash-Command wählen** – `/model llama3.2` wechselt das aktive Ollama-Modell zur Laufzeit ohne Server-Neustart
- [ ] **Config via Slash-Commands ändern** – WAKE_WORD, HISTORY_TURNS, TTS-Provider, Stimme (speaker_id) etc. ohne `.env`-Edit; Änderungen im Arbeitsspeicher, optional persistent via JSON-Datei
- [ ] **Debug-Modus per Slash-Command** – `/debug on` zeigt in einem Discord-Kanal: STT-Transkripte, Wake-Word-Treffer, LLM-Antworten, Verbindungs-Metriken (Latenz, Buffer-Füllstand, Jitter)
- [ ] **Server-Start per Slash-Command vom Bot** – `/startserver` pingst die konfigurierte PC-IP; wenn erreichbar, startet `Start-VoiceAssistant.ps1` via SSH oder Wake-on-LAN; nützlich wenn Server offline ist und jemand `/join` eingibt

---

## STT (Whisper)

Whisper kann mit `--print-special` oder via JSON-Output Token-Level-Infos zurückgeben:

- [ ] **Temperature-Optimierung** – Whisper default `temp=0.0` liefert deterministischen Output. Testen ob höhere Temperaturen (0.1–0.4) bei kurzen/unklaren Äußerungen bessere Ergebnisse bringen. Testmatrix: 3–4 Audiosamples × 5–6 Temperaturen, Ausgabe: Transkript, `avg_logprob`, `no_speech_prob`

- [ ] **`no_speech_prob`-Filter** – Wenn `no_speech_prob > 0.67` (Schwellwert testen), Transkript verwerfen statt weiterzureichen. Verhindert, dass Geräusche oder Hintergrundrauschen die LLM-Pipeline triggern. Rückgabe: leerer String oder `null`

- [ ] **Wort-Probabilitäts-Markierung** – Wörter mit niedrigem `token_prob` im Transkript markieren, z.B. `[unsicher]` oder kursiv im Discord-Chat. Sinnvoll für Transcript-Log; im Voice-Kanal weniger relevant

- [ ] **Verbessertes Stitching** – Whisper liefert Start/End-Timestamps pro Token. Damit ließe sich Silence-Splitting robuster machen (statt reiner RMS-Erkennung) und Chunk-Grenzen genauer setzen

---

## Pipeline & Server

- [ ] **Conversation-History persistent** – Gesprächsverlauf über Server-Neustart hinaus speichern (JSON-Datei pro Session-ID); aktuell geht History bei Neustart verloren
- [ ] **Mehrere gleichzeitige Sessions** – Aktuell keine Session-Isolation bei parallelen Sprechern in verschiedenen Channels; prüfen ob das ein reales Szenario ist

---

## Infrastruktur / Setup

- [ ] **`ollama serve` als Alternative zum Windows-Dienst** – Aktuell schlägt `ollama serve` fehl wenn der Dienst schon läuft (Port-Konflikt). Skript könnte den Dienst stoppen, `ollama serve` in eigenem Prozess starten und bei Shutdown beenden — vollständige Kontrolle über den Prozessbaum
- [ ] **Autostart via Task Scheduler** – `Start-VoiceAssistant.ps1 -Mode silent` als Windows-Aufgabe konfigurieren, trigger: "bei PC-Entsperrung" oder manuell via Verknüpfung
- [ ] **Obsidian-Vault als Kontext** – System-Prompt mit tagesaktuellem Kampagnenzustand aus dem Vault anreichern (z.B. letzte Session-Notiz); erfordert Vault-Lesezugriff vom Server
