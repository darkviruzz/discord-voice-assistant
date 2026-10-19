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
optional (lokale Server brauchen meist keinen) und nur per `.env` setzbar —
ebenso die Basis-URLs, an die ein Key geht (`STT_BASE_URL`, `LLM_BASE_URL`,
`EMBED_BASE_URL`, `TTS_BASE_URL`, `SUMMARY_BASE_URL`, `ELEVENLABS_BASE_URL`):
im Settings-Panel ließe sich sonst die Adresse auf einen fremden Server
umbiegen und der Key abgreifen. Das Panel zeigt sie nur an; ein früher dort
gespeicherter Wert wird beim Start ignoriert (Warnung im Log, „Zurücksetzen"
entfernt ihn). Die Adressen ohne Key (`WHISPER_URL`, `OLLAMA_URL`, `TTS_URL`)
bleiben im Panel änderbar.

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
| `STT_VOCABULARY` | Eigennamen der Kampagne, kommagetrennt — Whisper-Prompt für jede Transkription (s. u.) |
| `STT_VOCABULARY_FILE` | dieselbe Liste als Datei, absolut oder relativ zu `OBSIDIAN_VAULT_PATH` |

Alle Wege — Live-Streaming, Wake-Word-Pass und Finalize — laufen über denselben
Provider. Der `openai`-Adapter fordert `verbose_json` mit Wort-Zeitstempeln an;
lehnt ein Server das ab (400/415/422, z. B. ältere vLLM), fällt er einmalig auf
`json` zurück und merkt sich das bis zum Neustart (dann ohne Wort-Zeitstempel).
Ganze Wörter (OpenAI-Stil) und whisper.cpp-Subwort-Token werden automatisch
erkannt. Auch whisper.cpp selbst spricht den `openai`-Weg, wenn es mit
`--inference-path /v1/audio/transcriptions` gestartet wird.

### Namen-Vokabular (`STT_VOCABULARY`, `STT_VOCABULARY_FILE`)

Whisper liest den `prompt` als „bisheriges Transkript“: Namen, die dort stehen,
kommen sehr viel eher genau so geschrieben heraus („Gaglath Matho“ statt
„Gaglat Mato“). Beide Provider schicken bei **jeder** Anfrage — Live-Streaming,
Chunk-Fallback und Finalize-Re-STT — `<Vokabular>. <bisheriger Text>`:

```
Gaglath Matho, Rhogar Tonitruvales, Uhtred Ragnason, Greyhawk. <fixierter Text des Streamers>
```

- **Quellen:** `STT_VOCABULARY` (Panel, kommagetrennt) zuerst, dann
  `STT_VOCABULARY_FILE`. Die Datei darf eine normale Obsidian-Notiz sein: ein
  oder mehrere Namen pro Zeile, `#` leitet einen Kommentar ein (Überschriften
  werden ignoriert), Listenzeichen, Frontmatter und `[[Wikilinks]]` werden
  entfernt, Doppelte fallen weg. Datei-Änderungen greifen bei der nächsten
  Anfrage.
- **Budget:** Whisper (whisper.cpp wie die OpenAI-API) liest nur die **letzten
  224 Prompt-Token** und schneidet vorne ab. Deshalb wird der Prompt so gebaut,
  dass er passt: Vokabular ≤ 250 Zeichen (≈ 15–20 Namen, ~100 Token), danach so
  viel vom bisherigen Text, wie in 500 Zeichen insgesamt passt — gekürzt wird
  immer der Kontext, nie das Vokabular. Reihenfolge = Priorität; was nicht
  mehr passt, wird weggelassen und einmal pro Listenänderung im Log gewarnt.
  Die aktive Liste steht im `session_meta` unter `stt.vocabulary`.
- **Kandidaten aus dem Vault:** `npm run vocab:stt` (bzw.
  `node scripts/stt-vocabulary-candidates.mjs --vault <pfad>`) liest Notiz-Titel
  und `aliases` aus den Charakter-/NSC-/Orts-/Fraktions-Ordnern und sortiert
  nach Erwähnungen in den letzten Session-Notizen. Die Ausgabe ist nur ein
  Vorschlag (stdout, oder `--out <datei>`) — prüfen, kürzen, dann als
  `STT_VOCABULARY_FILE` ablegen. Ungeprüfte Vault-Inhalte landen nie
  automatisch im Prompt.
- **Session-Zusammenfassung:** Die Finalize-Zusammenfassung bekommt dieselbe
  Liste (ohne das 250-Zeichen-Limit, bis 1500 Zeichen) als „korrekte
  Schreibweisen“ in jeden LLM-Aufruf. Falsch erkannte Varianten im Transkript
  korrigiert das Modell dort stillschweigend.
- **Was gehört hinein:** Namen, die Whisper falsch schreibt — Spielercharaktere,
  häufige NSCs, Orte. Gängige Wörter („Die Gans“, „Gregor“) kosten nur Budget.
- **Risiko:** Ein Prompt kann Whisper in Stille oder bei Rauschen dazu bringen,
  Namen aus der Liste zu „hören“ (Prompt-Echo). Je länger die Liste, desto
  eher. Das Weckwort besser zunächst **nicht** in die Liste nehmen — ein Echo
  könnte den Assistenten auslösen.

**Wirkung messen** statt raten: in `bench/stt/profiles.json` dasselbe Profil
zweimal anlegen, einmal ohne Vokabular (`"STT_VOCABULARY": ""`,
`"STT_VOCABULARY_FILE": ""`) und einmal mit (`"STT_VOCABULARY_FILE":
"STT-Vokabular.md"` — relativ zum `OBSIDIAN_VAULT_PATH` aus
`apps/server/.env`; Panel-Overrides liest der Bench nicht), Vorlage in
[`bench/stt/profiles.example.json`](../bench/stt/profiles.example.json). Dann
`npm run bench:stt` vergleichen: **Namen-Recall** sollte steigen, **WER** darf nicht schlechter
werden; eine steigende Insertions-Zahl (I) deutet auf halluzinierte Namen.
Hinweis: Steht dieselbe Liste in `bench/stt/names.txt`, misst der Recall genau
die geprompteten Namen — für nicht gelistete Namen sagt er nichts.

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
| `LLM_THINK` | nur `ollama`: Feld `think` jeder Anfrage. `false` (Default) = direkt antworten, `true` = denken, `low`/`medium`/`high` = Stufe (gpt-oss), `auto` = weglassen |
| `LLM_REASONING_EFFORT` | nur `openai`, nur wenn gesetzt: `reasoning_effort` (z. B. `none`, `minimal`, `low`) |
| `LLM_CHAT_TEMPLATE_KWARGS` | nur `openai`, nur wenn gesetzt: JSON-Objekt als `chat_template_kwargs`, z. B. `{"enable_thinking":false}` |
| `SUMMARY_PROVIDER`, `SUMMARY_BASE_URL`, `SUMMARY_API_KEY` | optional eigener Server für beide Zusammenfassungen (siehe unten) |

### Denkphase (Reasoning-Modelle)

Reasoning-Modelle wie `gemma4`, `qwen3` oder `deepseek-r1` „denken" vor der
Antwort, wenn man es ihnen nicht abstellt. Für eine vorgelesene Antwort ist das
reine Wartezeit: Am 2026-10-18 erzeugte `gemma4:12b` für eine Antwort von 290
Zeichen 1506 Tokens (42,6 s Generierung, ~50 s bis zur Sprachausgabe); mit
`think: false` waren es 19 Tokens in 0,7 s. Deshalb schickt der Server bei
Ollama standardmäßig `think: false` — für Antworten, beide Zusammenfassungen und
den Keep-Warm-Ping. Nicht-Reasoning-Modelle (llama3.2 …) akzeptieren
`false` ebenfalls. Lehnt ein Modell den eingestellten Wert ab (HTTP 400, z. B.
`LLM_THINK=true` bei llama3.2), fragt der Server einmal ohne `think` nach und
merkt sich das für dieses Modell.

OpenAI-kompatible Server haben dafür kein einheitliches Feld, und ein strikter
Server lehnt unbekannte Felder ab. Deshalb wird dort nur gesendet, was gesetzt
ist: `LLM_REASONING_EFFORT` (OpenAI-Standard, z. B. vLLM mit gpt-oss, Ollama
`/v1`) bzw. `LLM_CHAT_TEMPLATE_KWARGS={"enable_thinking":false}` (vLLM,
llama.cpp-Server, SGLang mit Qwen3 & Co.).

### Eigener Server für die Zusammenfassungen

Die rollende und die Session-Zusammenfassung laufen standardmäßig über
denselben Server wie die Antworten (mit `SUMMARY_MODEL` als eigenem
Modellnamen). Mit `SUMMARY_PROVIDER` / `SUMMARY_BASE_URL` gehen sie an einen
anderen — etwa damit eine 3-h-Session auf einem größeren Modell innerhalb von
`SESSION_SUMMARY_TIMEOUT_MS` fertig wird, ohne das Live-Modell zu verdrängen:

| Key | leer = |
|---|---|
| `SUMMARY_PROVIDER` | `LLM_PROVIDER` |
| `SUMMARY_BASE_URL` | `OLLAMA_URL` bzw. `LLM_BASE_URL` des gewählten Anbieters |
| `SUMMARY_MODEL` | `OLLAMA_MODEL` bzw. `LLM_MODEL` des gewählten Anbieters — bei abweichendem Anbieter setzen |
| `SUMMARY_API_KEY` | `LLM_API_KEY`, aber nur, wenn es derselbe Server ist |

`SUMMARY_BASE_URL` und `SUMMARY_API_KEY` sind nur über `.env` änderbar, nicht
im Panel: der Server schickt den Schlüssel an diese Adresse. Ohne
`SUMMARY_BASE_URL` geht ein Key nur an `LLM_BASE_URL` (bei `openai`), nie an
die im Panel änderbare `OLLAMA_URL`.
`LLM_REASONING_EFFORT` / `LLM_CHAT_TEMPLATE_KWARGS` gelten nur für den
Antwort-Server; `LLM_THINK` gilt für jeden Ollama-Server.

## Embeddings

| Key | Bedeutung |
|---|---|
| `EMBED_PROVIDER` | `ollama` (`/api/embed` auf `OLLAMA_URL`) oder `openai` (`/embeddings` auf `EMBED_BASE_URL`) |
| `EMBED_MODEL` | Default `nomic-embed-text` |
| `EMBED_KEEP_ALIVE` | nur Ollama; Default `30m`, damit die erste Suche nach einer Pause nicht auf das Laden wartet |
| `EMBED_QUERY_PREFIX` / `EMBED_DOC_PREFIX` | Task-Präfixe; für nomic-Modelle automatisch `search_query: ` / `search_document: ` |

Modell- oder Präfix-Wechsel machen alte Vektoren unbrauchbar — der Vault-Index
erkennt das (Signatur) und baut sich neu auf.

**Warm-up (Ollama):** Eine Suche hat nur `RAG_TIMEOUT_MS` (800 ms) und bricht
danach ab. Ein kaltes Embedding-Modell lädt ungefähr so lange, und Ollama
bricht das Laden ab, sobald der Client weg ist. Ist der Index von der Platte
geladen, lädt sonst nichts das Modell — am 2026-10-18 fiel so jede Suche des
Abends auf `CAMPAIGN.md` zurück. Der Server lädt das Embedding-Modell deshalb
ohne diese Frist: beim Start, wenn der Bot den Voice-Channel betritt (und bei
jedem Keep-Warm-Ping, `OLLAMA_KEEP_WARM_INTERVAL_MS`) und nach einer
fehlgeschlagenen Suche im Hintergrund, damit die nächste klappt. (Die
Ollama-Warnung `num_ctx=8192 > n_ctx_train=2048` für nomic ist harmlos: Ollama
begrenzt den Kontext selbst auf 2048.)

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
