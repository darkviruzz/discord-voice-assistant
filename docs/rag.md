# Vault-Suche (RAG)

Semantische Suche über den Obsidian-Vault der Kampagne. Sie läuft **im Node-Server**
(`apps/server/src/rag/`, reines JavaScript, keine nativen Module) — kein eigener
Dienst, kein Port, kein Python. Pro Wake-Word-Query liefert sie die passendsten
Vault-Abschnitte als Kampagnen-Kontext (auch für getippte Fragen wie `/ask`
und `/recap`). Ist RAG aus, der Index noch nicht gebaut oder
schlagen die Embeddings fehl, nutzt der Server wie bisher das statische
`CAMPAIGN.md` — die Voice-Pipeline wartet höchstens `RAG_TIMEOUT_MS`.

Aktiv, sobald `OBSIDIAN_VAULT_PATH` gesetzt ist (`RAG_ENABLED=false` schaltet ab).

## Ablauf

1. **Scan** – jede `.md` unter `OBSIDIAN_VAULT_PATH`. Punkt-Verzeichnisse
   (`.obsidian`, `.trash`, `.git`, …) werden übersprungen, Notizen im
   Obsidian-Papierkorb tauchen also nie als Kontext auf. Ungültiges UTF-8 wird
   ersetzt statt den Scan abzubrechen; Notizen über 2 MiB werden übersprungen.
2. **Frontmatter** – ein führender `--- … ---`-YAML-Block wird abgetrennt und als
   Metadaten gespeichert, nicht eingebettet. Was keine YAML-Map ist (ungültiges
   YAML, Liste, eine Notiz, die nur mit einer `---`-Trennlinie beginnt), bleibt
   Text — es geht nie Inhalt verloren.
3. **Chunking** – an jeder `##`-Überschrift (nicht in Code-Fences); alles vor der
   ersten `##` ist ein eigener Abschnitt. Längere Abschnitte werden bei
   `RAG_MAX_CHUNK_CHARS` an Absatz-/Zeilen-/Wortgrenzen geteilt, Fortsetzungen
   wiederholen die Überschrift.
4. **Embedding** – über `apps/server/src/providers/embed.js`: Ollama
   (`/api/embed`, Standard `nomic-embed-text` mit den Task-Präfixen
   `search_document:` / `search_query:`, `keep_alive`) oder ein beliebiger
   OpenAI-kompatibler `/embeddings`-Server (`EMBED_PROVIDER=openai`).
5. **Index** – L2-normalisierte Float32-Vektoren, Brute-Force-Cosinus über alle
   Abschnitte (Vaults haben Hunderte bis wenige Tausend; gemessen ~1 ms für 500,
   ~7 ms für 3000 Abschnitte à 768 Dimensionen). Persistiert in
   `RAG_INDEX_DIR/index.bin`.
6. **Sync** – bei jedem Start im Hintergrund (holt auch Änderungen nach, die
   während der Server aus war gemacht wurden), danach per Datei-Watcher
   (`fs.watch` rekursiv, ~1 s entprellt, jede Notiz wird aus ihrem *aktuellen*
   Zustand auf der Platte synchronisiert) plus periodischem Abgleich
   (`RAG_RESCAN_INTERVAL_MS`) als Absicherung. Inkrementell per Inhalts-Hash:
   nur neue/geänderte Notizen werden eingebettet, gelöschte entfernt;
   verschobene/umbenannte Notizen (auch ganze Ordner) übernehmen ihre Vektoren
   ohne Neu-Einbetten. Der periodische Abgleich und Ordner-Ereignisse prüfen nur
   Größe + Änderungszeit (ein `stat` pro Notiz, gemessen ~80 ms für 1000
   Notizen statt ~0,5 s mit Lesen + Hashen); Start-Sync und Einzel-Ereignisse
   vergleichen immer den Inhalt.
7. **Abfrage** – Frage einbetten, Top-k (1–20) nächste Abschnitte, optional
   gefiltert mit `RAG_SCORE_THRESHOLD`; Ergebnis `[{ text, source, distance }]`.

## Fehlerverhalten

- Der Index wird nie vorab geleert. Alle Embeddings einer Notiz entstehen,
  *bevor* ihre alten Abschnitte ersetzt werden — fällt Ollama mitten im Sync
  aus, bleiben die alten Abschnitte (auch aller noch nicht verarbeiteten
  Notizen) durchsuchbar. Der Start-Sync wiederholt mit Backoff (5 s … 5 min).
- Eine kaputte/gesperrte Notiz wird geloggt und übersprungen, nie der ganze Sync.
- Wechsel von Anbieter, Modell oder Präfixen (Embedding-Signatur, auch live im
  Web-Panel) → Index wird verworfen und neu aufgebaut; bis dahin `CAMPAIGN.md`.
  Eine Änderung von `RAG_MAX_CHUNK_CHARS` bettet jede Notiz einmal neu ein.
- Watcher-Fehler (Plattform ohne rekursives `fs.watch`, inotify-Limit) schalten
  nur den Watcher ab — der periodische Abgleich hält den Index trotzdem aktuell.
- Index-Datei kaputt/fremd → wird verworfen und aus dem Vault neu gebaut.
  Löschen von `RAG_INDEX_DIR` ist jederzeit gefahrlos.

## Index-Datei (`index.bin`)

Eine Datei, atomar geschrieben (Temp-Datei + fsync + rename — ein Absturz
mitten im Speichern lässt den alten Index intakt):

| Bytes | Inhalt |
|---|---|
| 0–7 | Magic `VARAGIX\n` |
| 8–11 | Format-Version (uint32 LE) |
| 12–15 | Länge H des JSON-Headers (uint32 LE) |
| 16… | JSON-Header: `signature` (Embedding-Signatur), `dim`, `chunks`, `endian`, `savedAt`, `notes: [{ source, hash, meta, chunks: [{ heading, text }] }]` |
| … | Null-Padding auf 4 Byte, dann `chunks × dim` Float32 in Header-Reihenfolge |

Größenordnung: ~4 KB pro Abschnitt bei 768 Dimensionen (3000 Abschnitte ≈ 13 MB).

## Einstellungen

Alle im Web-Panel (Gruppe „Server · RAG (Vault-Suche)") und in
`apps/server/.env.example` dokumentiert:

| Variable | Standard | Kurz |
|---|---|---|
| `RAG_ENABLED` | `true` | an/aus (nur mit `OBSIDIAN_VAULT_PATH`) |
| `RAG_TIMEOUT_MS` | `800` | Budget pro Abfrage, danach `CAMPAIGN.md` |
| `RAG_SCORE_THRESHOLD` | leer | max. Cosine-Distanz (1 − Ähnlichkeit); Startwert ~0.5 |
| `RAG_MAX_CHUNK_CHARS` | `2000` | max. Zeichen pro Abschnitt |
| `RAG_INDEX_DIR` | `./data/rag` | Index-Verzeichnis (Docker: `/data/rag`) |
| `RAG_RESCAN_INTERVAL_MS` | `300000` | periodischer Abgleich, `0` = aus |
| `RAG_EXCLUDE` | leer | nie indexierte Pfade, z. B. `Templates/, wiki-comments/, CLAUDE.md, *.excalidraw.md` (`Ordner/` = in jeder Tiefe, `a/b/` = ab Vault-Wurzel, `*`/`**` Platzhalter) |
| `EMBED_PROVIDER` | `ollama` | `ollama` \| `openai` |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding-Modell |
| `EMBED_BASE_URL` / `EMBED_API_KEY` | leer | nur `openai` (URL inkl. `/v1`) |
| `EMBED_KEEP_ALIVE` | `30m` | Ollama hält das Modell geladen |
| `EMBED_QUERY_PREFIX` / `EMBED_DOC_PREFIX` | leer = auto | Task-Präfixe; `" "` = keins |

**Schwellwert kalibrieren:** mit `DEBUG=1` loggt jede Abfrage ihre Treffer samt
Distanz (`rag: query "…" → 3 hit(s) [npc/graf.md 0.31, …]`). Gute Treffer liegen
mit `nomic-embed-text` meist bei 0.2–0.45.

## Betrieb

- **Docker** (`deploy/docker-compose.yml`): der `server`-Container indexiert das
  read-only `campaign`-Volume, Index auf `server-data` (`/data/rag`).
  `deploy/scripts/start.sh` zieht `EMBED_MODEL` in den `ollama`-Dienst, außer
  bei `RAG_ENABLED=false` oder `EMBED_PROVIDER=openai`.
- **Windows nativ**: `scripts/Setup-VoiceAssistant.ps1` prüft/lädt das
  Embedding-Modell in Ollama; der Launcher exportiert nur `VA_VAULT_PATH` →
  `OBSIDIAN_VAULT_PATH`, alle übrigen RAG-Einstellungen stehen in
  `apps/server/.env` bzw. im Web-Panel.
- **Status**: `session_meta.rag` im Transkript-JSONL (Anbieter, Modell, Index:
  Notizen/Abschnitte/letzter Sync/Watcher).

## Umstieg vom Python-Dienst (`apps/rag/`)

- `RAG_URL` entfällt; RAG ist an, sobald ein Vault gesetzt ist.
- `RAG_EMBED_MODEL` / `RAG_EMBED_KEEP_ALIVE` heißen jetzt `EMBED_MODEL` /
  `EMBED_KEEP_ALIVE` (`deploy/.env`).
- Altlasten löschen: `apps/rag/` (venv + Chroma-Store) im Windows-Checkout,
  das Docker-Volume `<projekt>_rag-chroma`, das GHCR-Package `va-rag`. Ein noch
  laufender alter RAG-Prozess auf Port 5001 wird vom neuen Launcher nicht mehr
  gestoppt — einmal von Hand beenden.
- Der erste Start baut den Index neu auf (einmal alle Notizen einbetten).

## Tests

`npm test` (keine GPU/Ollama nötig): `apps/server/test/ragChunking.test.js`
(Frontmatter, Chunking, Scan, Store/Format), `ragIndexer.test.js`
(inkrementeller Sync, Fehlertoleranz, Persistenz, Watcher — mit injiziertem,
deterministischem Embedder) und `ragService.test.js` (Ende-zu-Ende über
`queryRag` gegen ein Fake-Ollama `/api/embed`). Die Fälle sind aus der
pytest-Suite des früheren Python-Dienstes portiert.

## Vergangene Sessions

Finalize schreibt eine Zusammenfassung (`summary.md` im Archiv). So entsteht sie:

- **Eingabe:** nur die Zeilen der Spieler, ohne Rabenauges Antworten. Pro Zeile
  bleibt nur `Spieler (Figur): Text`. Zeitstempel, `**`-Markup und
  `_[unterbricht]_`/`_[weiter]_` fallen weg. Sie kosteten rund ein Drittel der
  Token, weil Ziffern einzeln tokenisiert werden.
- **Abschnitte:** Die Zeilen werden in Abschnitte von
  `SESSION_SUMMARY_CHUNK_CHARS` geteilt, Standard 18000 Zeichen ≈ 5,6k Token.
  Jeder Abschnitt wird zu einer Notiz verdichtet. Die Notizen werden zu einem
  Text von höchstens `SESSION_SUMMARY_MAX_CHARS` zusammengeführt. Passen sie
  nicht in einen Aufruf, werden sie vorher gruppenweise zusammengefasst. So
  bleibt jeder Aufruf im Kontextfenster.
- **Schreibweisen:** Jeder Aufruf bekommt die Namen aus
  `STT_VOCABULARY`/`_FILE` als korrekte Schreibweisen.
- **Gemessen** am 2026-10-19 (3-h-Session, 245 KB, gemma4:12b auf der
  RX 6800 XT, Ollama-Kontext 8192): vorher 21 + 1 Aufrufe in 9,6 min, die
  Zusammenführung mit 7,5k Token fast am Limit. Jetzt 10 + 1 Aufrufe in
  5,2 min. Die Abschnitte haben höchstens 6,0k Token, die Zusammenführung
  3,7k. „Gaaglath“, „Wyern“, „Ylva Benschalam“ und „Spungnitu“ kommen jetzt
  richtig geschrieben heraus.
- **Zeitbudget:** `SESSION_SUMMARY_TIMEOUT_MS`, Standard 30 min. Jeder Aufruf
  meldet Fortschritt an den Bot. Wird das Budget knapp, hört das Verdichten
  rechtzeitig auf, damit noch Zeit für die Zusammenführung bleibt.
- **Unvollständig:** Entsteht die Zusammenfassung dann aus den bis dahin
  fertigen Notizen, endet sie mit einem Hinweis, z. B. „(Unvollständig —
  Zeitbudget aufgebraucht: 7 von 10 Abschnitten berücksichtigt, reicht bis etwa
  21:47 Uhr.)“. Bleibt keine Zeit mehr für die Zusammenführung, werden die
  Notizen gekürzt aneinandergereiht. Nur wenn gar kein Abschnitt verdichtet
  wurde, gibt es keine Zusammenfassung.

Die jeweils
letzte bekommt Rabenauge bei jeder Anfrage als Hintergrund
(`LAST_SESSION_CONTEXT_*`) — beantwortet wird das nur auf Nachfrage („Was war
letztes Mal?“) bzw. per `/recap`, nie als Begrüßung. Damit auch ältere
Sessions über die Vault-Suche auffindbar sind, `SESSION_SUMMARY_VAULT_DIR`
setzen: dann landet jede Zusammenfassung als Notiz im Vault und wird
automatisch mitindiziert. Im Docker-Stack geht das nicht: dort ist der Vault
(`campaign`-Volume) read-only eingebunden (mit `CAMPAIGN_REMOTE` zieht
`start.sh` ihn zudem bei jedem Start neu) — der Schreibversuch wird nur geloggt.
