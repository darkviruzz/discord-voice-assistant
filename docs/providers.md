# Modell-Provider (STT · TTS · LLM · Embeddings)

Der Server spricht jedes Modell über eine Provider-Schicht an
(`apps/server/src/providers/`). Welcher Inferenz-Server dahintersteht, ist
reine Konfiguration — kein Code-Umbau. Standard ist überall das bisherige
Verhalten (whisper.cpp, Piper, Ollama).

| Baustein | Schalter | Optionen | Standard |
|---|---|---|---|
| Spracherkennung | `STT_PROVIDER` | `whispercpp` · `openai` | `whispercpp` |
| Sprachausgabe | `TTS_PROVIDER` | `piper` · `openai` · `elevenlabs` | `piper` |
| Sprachmodell | `LLM_PROVIDER` | `ollama` · `openai` | `ollama` |
| Embeddings (Vault-RAG) | `EMBED_PROVIDER` | `ollama` · `openai` | `ollama` |

`openai` heißt jeweils: **irgendein Server mit OpenAI-kompatibler API** —
vLLM / vLLM-Omni, AMD Lemonade, llama.cpp-Server, LM Studio, Speaches,
Ollamas eigenes `/v1`, oder ein Cloud-Anbieter. Die Basis-URL enthält immer den
Versionspfad (`…/v1`); der Server hängt `/audio/transcriptions`,
`/audio/speech`, `/chat/completions` bzw. `/embeddings` an. API-Keys sind
optional (lokale Server brauchen meist keinen) und nur per `.env` setzbar.

Alle Schalter werden pro Anfrage gelesen: ein Wechsel im Settings-Panel
greift ab der nächsten Anfrage.

## Spracherkennung (STT)

| Key | Bedeutung |
|---|---|
| `STT_PROVIDER` | `whispercpp` (whisper-server, `/inference`) oder `openai` (`/audio/transcriptions`) |
| `WHISPER_URL` | bei `whispercpp` |
| `STT_BASE_URL`, `STT_MODEL`, `STT_API_KEY` | bei `openai` (`STT_BASE_URL` **mit** `/v1`) |
| `STT_LANGUAGE` | überschreibt `WHISPER_LANGUAGE` für beide Provider (leer = `WHISPER_LANGUAGE`) |
| `STT_TIMEOUT_MS` | Obergrenze pro Anfrage inkl. Antwort (Default 120 s; vorher unbegrenzt) |

Alle Wege — Live-Streaming, Wake-Word-Pass und Finalize — laufen über denselben
Provider. Der `openai`-Adapter fordert `verbose_json` mit Wort-Zeitstempeln an;
lehnt ein Server das ab (400/415/422, z. B. ältere vLLM), fällt er einmalig auf
`json` zurück und merkt sich das bis zum Neustart (dann ohne Wort-Zeitstempel).
Ganze Wörter (OpenAI-Stil) und whisper.cpp-Subwort-Token werden automatisch
erkannt. Auch whisper.cpp selbst spricht den `openai`-Weg, wenn es mit
`--inference-path /v1/audio/transcriptions` gestartet wird.

## Sprachausgabe (TTS)

| Key | Bedeutung |
|---|---|
| `TTS_PROVIDER` | `piper` (Standard), `openai` (`/audio/speech`) oder `elevenlabs` |
| `TTS_URL` | bei `piper` |
| `TTS_BASE_URL`, `TTS_MODEL`, `TTS_VOICE`, `TTS_API_KEY` | bei `openai` |
| `TTS_RESPONSE_FORMAT` | `pcm` (rohes s16le mono mit `TTS_SAMPLE_RATE`, Default 24000) oder `wav` (Rate/Kanäle aus dem Header) |
| `TTS_SPEED` | optional, leer = Server-Default |
| `TTS_TIMEOUT_MS` | Verbindung + Header **und** jede Pause zwischen Audio-Chunks (Default 30 s) — begrenzt nicht die Länge eines langen Satzes |

Unterbricht jemand die Ausgabe (Barge-in), endet der Stream bei allen Providern
still und die Verbindung wird freigegeben. Stimmungs-Sprecher (0–7) und die
Wahl `emotional`/`high` aus der LLM-Antwort gibt es nur bei Piper; andere
Provider nutzen immer die eine konfigurierte Stimme. Ist die Sample-Rate eines
Servers unklar, `TTS_RESPONSE_FORMAT=wav` setzen. Komprimierte Antworten
(mp3/opus/…) werden mit einem Hinweis abgelehnt.

## LLM

| Key | Bedeutung |
|---|---|
| `LLM_PROVIDER` | `ollama` (natives API, Keep-Warm per `OLLAMA_KEEP_ALIVE`) oder `openai` |
| `OLLAMA_URL`, `OLLAMA_MODEL` | bei `ollama` |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | bei `openai` (`LLM_MODEL` leer → `OLLAMA_MODEL`) |
| `SUMMARY_MODEL` | eigenes Modell für die rollende Zusammenfassung und die Session-Zusammenfassung beim Finalize (beide Provider) |
| `LLM_TIMEOUT_MS` | Obergrenze pro Antwort (Default 120 s; vorher unbegrenzt) |

Die Antwort-, Zusammenfassungs- und Session-Zusammenfassungs-Aufrufe laufen
alle über denselben Provider.

## Embeddings

| Key | Bedeutung |
|---|---|
| `EMBED_PROVIDER` | `ollama` (`/api/embed` auf `OLLAMA_URL`) oder `openai` (`/embeddings` auf `EMBED_BASE_URL`) |
| `EMBED_MODEL` | Default `nomic-embed-text` |
| `EMBED_KEEP_ALIVE` | nur Ollama; Default `30m`, damit die erste Suche nach einer Pause nicht auf das Laden wartet |
| `EMBED_QUERY_PREFIX` / `EMBED_DOC_PREFIX` | Task-Präfixe; für nomic-Modelle automatisch `search_query: ` / `search_document: ` |

Modell- oder Präfix-Wechsel machen alte Vektoren unbrauchbar — der Vault-Index
erkennt das (Signatur) und baut sich neu auf.

## Typische Kombinationen

**Windows + AMD (aktuell):** whisper.cpp (Vulkan) · Piper (DirectML) · Ollama.
Alles Standard, nichts zu setzen.

**Windows + AMD, ein Server weniger:** AMD *Lemonade* bündelt LLM
(llama.cpp/Vulkan), Spracherkennung (whisper.cpp) und Embeddings hinter
OpenAI-kompatiblen Endpunkten und kann Ollama **und** whisper-server ersetzen.
Sein TTS (Kokoro) kann kein Deutsch → Piper bleibt.

```ini
LLM_PROVIDER=openai
LLM_BASE_URL=http://localhost:<lemonade-port>/<pfad-laut-lemonade-doku>/v1
LLM_MODEL=<modellname in lemonade>
STT_PROVIDER=openai
STT_BASE_URL=<dieselbe basis-url>
STT_MODEL=<whisper-modell in lemonade>
EMBED_PROVIDER=openai
EMBED_BASE_URL=<dieselbe basis-url>
EMBED_MODEL=<embedding-modell in lemonade>
```

Exakte Pfade/Modellnamen stehen in der Lemonade-Doku (Server-Spec); sie
ändern sich zwischen Versionen.

**Linux + NVIDIA (Cloud, z. B. A6000):** vLLM für LLM, vLLM-Omni für TTS
(z. B. Qwen3-TTS) und Spracherkennung (z. B. Voxtral) — je ein `vllm serve`
pro Modell, alle über `*_PROVIDER=openai`. Bei mehreren Modellen auf einer
GPU unbedingt `--gpu-memory-utilization` pro Prozess setzen, sonst belegt der
erste ~90 % VRAM.

## Vergleichen statt raten

`npm run bench:stt` (siehe [`bench/stt/README.md`](../bench/stt/README.md))
misst WER und Namen-Recall verschiedener STT-Profile an euren eigenen
Aufnahmen.

## Docker-Compose-Hinweis

In `deploy/docker-compose.yml` stehen die Provider-Keys im `environment:` des
`server`-Dienstes; diese Werte schlagen `server.env`. Provider-Einstellungen
für den Container-Betrieb daher in `deploy/.env` setzen.
