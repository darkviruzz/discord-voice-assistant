# TODO & Ideen

Gesammelte Feature-Ideen und Verbesserungen. Kein Versprechen auf Umsetzung.

---

## Bot / Discord UX

- [ ] **Version-Anzeige** – Bot-Status zeigt Bot- und Server-Version an
  - Versionsstrategie: `package.json`-Version + kurzer Git-Hash, z.B. `1.0.1-d5b717a`
    → Hash ändert sich automatisch bei jedem Commit, kein manuelles Bumping erforderlich
  - Bot-Status (Discord Presence/Activity):
    - Server online:  `1.0.1-d5b717a (server:1.0.1-d5b717a)`
    - Server offline: `1.0.1-d5b717a`
  - Kein `/version` Slash-Command nötig
  - **Server:**
    - Liest beim Start `package.json`-Version + `git rev-parse --short HEAD` → ersetzt hardcoded `SERVER_VERSION = '0.1.0'` in `apps/server/src/control.js`
    - Loggt Version beim Startup: `Server v1.0.1-d5b717a gestartet`
    - Sendet Version bereits über `hello`-Message beim Verbindungsaufbau (`{ type: 'hello', version: '...' }`) — Infrastruktur ist vorhanden, nur Wert ist hardcoded
  - **Bot:**
    - Liest beim Start ebenfalls `package.json`-Version + git hash
    - Setzt initial Activity auf eigene Version (Server noch unbekannt)
    - Beim Empfang der `hello`-Message von Server: Activity auf kombinierte Version updaten
    - Bei Verbindungsverlust: Activity auf reine Bot-Version zurücksetzen
  - **Implementierung:**
    - Hilfsfunktion `getVersionString()` (je einmal in bot und server) — liest `package.json` + `execSync('git rev-parse --short HEAD')`
    - `apps/server/src/control.js`: `SERVER_VERSION` durch Aufruf von `getVersionString()` beim Modulstart ersetzen
    - `apps/bot/src/index.js`: `clientReady` → Activity setzen; `hello`-Handler → Activity updaten; Disconnect-Handler → Activity zurücksetzen
    - `apps/bot/src/transport/control.js`: `hello`-Message auswerten und Server-Version nach oben weitergeben

- [ ] **Type-to-Ask Feature** – Nutzer können Fragen per Text mit `/ask "Frage"` stellen, statt nur per Sprache
  - Sessionless: Funktioniert auch ohne aktive Voice-Session (nur Text-Response in Discord)
  - Optional TTS: Flag `/ask "Frage" tts:true` spielt Antwort als Audio ab (nur wenn Bot im Voice-Channel)
  - Shared History: Text-Queries verwenden dieselbe Conversation-History wie Voice-Queries
  - **Implementierung:**
    - Bot: Neuer Slash-Command mit `question` (string) + `tts` (bool, default=false) Parametern
    - Bot: Handler sendet `text_query` Message über Control-Plane an Server
    - Server: Neue `runTextPipeline()` Funktion, skippt STT/Wake-Word, startet direkt bei LLM
    - Server: Reuse von `chat()`, `synthesize()`, History-Management, Opus-Encoding
    - Verification: Sessions vs. sessionless, TTS-Flag Kombis, History-Mixing voice+text
- [ ] **LLM-Modell per Slash-Command wählen** – `/model llama3.2` wechselt das aktive Ollama-Modell zur Laufzeit ohne Server-Neustart
- [ ] **Config via Slash-Commands ändern** – WAKE_WORD, HISTORY_TURNS, TTS-Provider, Stimme (speaker_id) etc. ohne `.env`-Edit; Änderungen im Arbeitsspeicher, optional persistent via JSON-Datei
- [ ] **Debug-Modus per Slash-Command** – `/debug on` zeigt in einem Discord-Kanal: STT-Transkripte, Wake-Word-Treffer, LLM-Antworten, Verbindungs-Metriken (Latenz, Buffer-Füllstand, Jitter)
- [ ] **Server-Start per Slash-Command vom Bot** – `/startserver` pingst die konfigurierte PC-IP; wenn erreichbar, startet `Start-VoiceAssistant.ps1` via SSH oder Wake-on-LAN; nützlich wenn Server offline ist und jemand `/join` eingibt

---

## STT (Whisper)

Whisper kann mit `--print-special` oder via JSON-Output Token-Level-Infos zurückgeben:

- [ ] **Temperature-Optimierung** – Whisper default `temp=0.0` liefert deterministischen Output. Testen ob höhere Temperaturen (0.1–0.4) bei kurzen/unklaren Äußerungen bessere Ergebnisse bringen. Testmatrix: 3–4 Audiosamples × 5–6 Temperaturen, Ausgabe: Transkript, `avg_logprob`, `no_speech_prob`, mean/median `probability` erkannter Token

- [ ] **`no_speech_prob`-Filter** – Wenn `no_speech_prob > 0.67` (Schwellwert testen), Transkript verwerfen statt weiterzureichen. Verhindert, dass bei Geräusche oder Hintergrundrauschen Subtitle-Quatsch erkannt wird. Rückgabe: leerer String oder `null`

- [ ] **Wort-Probabilitäts-Markierung** – Wörter mit niedrigem `token_prob` im Transkript markieren, z.B. `[unsicher]` oder kursiv im Discord-Chat. Sinnvoll für Transcript-Log; im Voice-Kanal weniger relevant

- [ ] **Verbessertes Stitching** – Whisper liefert Start/End-Timestamps pro Token. Damit ließe sich Silence-Splitting robuster machen (statt reiner RMS-Erkennung) und Chunk-Grenzen genauer setzen. Bzw matching über gleich erkannte token. bzw nächstes audiosnippet bei zuletzt erkanntem Satzzeichen (.!?) starten damit genug überlappt.

---

## TTS (Piper Streaming)

Piper ist schnell auf CPU (~100-200ms pro Satz), auf GPU (AMD 6800XT) sollte es noch schneller sein. Mehrere Streaming-Implementierungen verfügbar (WebSocket-basiert). Falls möglich mit Whisper + Ollama parallel nutzen.

- [ ] **Evaluate Piper Streaming Repos** – Vergleich: [piper-streaming](https://github.com/jitendraparande/piper-streaming) (WebSocket), [paroli](https://github.com/marty1885/paroli) (C++); Entscheidung: WebSocket wahrscheinlich best für Discord-Integration
- [ ] **GPU Support evaluieren** – VRAM-Check: Piper braucht ~200-500MB (vs. Whisper/Ollama). AMD 6800XT hat 16GB, sollte parallel laufen. Testen ob Piper ONNX/HIP-Unterstützung hat
- [ ] **API Refactoring** – Jetzige Piper-API zu Streaming umbauen: `POST /tts/synthesize` mit `{text, voice, speed, sample_rate}` → WebSocket-Endpoint mit Audio-Chunks (PCM16)
- [ ] **TTS Settings hinzufügen** – Voice-Selektion, Speed (0.5–2.0), Sample Rate (22050, 48000), optional Pitch/Prosody
- [ ] **Standardisierte API** – An [Pipecat TTS Service Spec](https://docs.pipecat.ai/server/services/tts/piper) orientieren für Wartbarkeit

---

## Pipeline & Server

- [ ] **Conversation-History persistent** – Gesprächsverlauf über Server-Neustart hinaus speichern (JSON-Datei pro Session-ID); aktuell geht History bei Neustart verloren
- [ ] **Mehrere gleichzeitige Sessions** – Aktuell keine Session-Isolation bei parallelen Sprechern in verschiedenen Channels; prüfen ob das ein reales Szenario ist ← Nein, Bot auf einen Channel begrenzt!
- [ ] **Transkript als Kontext** - das vollständige Transkript bzw eine summary könnte als Kontext bei LLM Anfragen übergeben werden

---

## Infrastruktur / Setup

- [ ] **Autostart via Task Scheduler** – `Start-VoiceAssistant.ps1 -Mode silent` als Windows-Aufgabe konfigurieren, trigger: "bei PC-Entsperrung" oder manuell via Verknüpfung
- [ ] **Obsidian-Vault als Kontext** – System-Prompt mit tagesaktuellem Kampagnenzustand aus dem Vault anreichern (z.B. letzte Session-Notiz); erfordert Vault-Lesezugriff vom Server


## Andere / Unsortiert

- packages.json hat noch node>=20, aber benötigt eigentlich 22