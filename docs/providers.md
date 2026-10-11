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

## LLM

| Key | Bedeutung |
|---|---|
| `LLM_PROVIDER` | `ollama` (natives API, Keep-Warm per `OLLAMA_KEEP_ALIVE`) oder `openai` |
| `OLLAMA_URL`, `OLLAMA_MODEL` | bei `ollama` |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | bei `openai` (`LLM_MODEL` leer → `OLLAMA_MODEL`) |
| `SUMMARY_MODEL` | eigenes Modell für die rollende Zusammenfassung (beide Provider) |
| `LLM_TIMEOUT_MS` | Obergrenze pro Antwort (Default 120 s; vorher unbegrenzt) |

Die Antwort-, Zusammenfassungs- und Briefing-Aufrufe laufen alle über
denselben Provider.

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
