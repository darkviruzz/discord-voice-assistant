# discord-assistant

Funktionen:
- /join: Bot joint Voice, startet Session
- /leave: verlässt Voice
- /save-session: schließt Session, mischt alle Beiträge zeitlich korrekt zu `session_mix.ogg`
- Pro Sprecher & Äußerung getrennte WAV-Chunks (48 kHz, mono)
- Keine Speicherung langer Stille (Auto-Stopp nach ~1 s Stille)
- Optional Live-Streaming der PCM-Daten via TCP an STT

Ablage:
- `data/<SessionID>/session.json`
- `data/<SessionID>/chunks/*.wav`
- `data/<SessionID>/session_mix.ogg`

Hinweise:
- Erfordert `ffmpeg` im PATH
