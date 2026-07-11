# Plan: Cloud-Finalize, Web-UI und RAG fertigstellen

Stand: 2026-07-11, Branch `claude/rag-integration-orchestration-inmqox`. Basiert auf einer Drei-Branch-Analyse
(Kompatibilität + Vollständigkeit) von `fix/finalize-cloud-dataflow`,
`claude/rag-service-phase-4-bml2jq` und dem Web-UI-Reststand laut
[`fix-gpu-deployment-and-webui-merge.md`](fix-gpu-deployment-and-webui-merge.md).

> **Fortschritt:**
> - ✅ **Schritt 1** — `fix/finalize-cloud-dataflow` gemergt (`c4501b9`), 140 Tests grün. Offen: nur Live-Verify auf echter Instanz.
> - ✅ **R7** — nginx-Reverse-Proxy fürs Web-UI erledigt (vom User bestätigt).
> - ✅ **Schritt 2 (RAG)** — RAG-Branch per Merge-Commit integriert (`081809d`), Katalog/config_state
>   (`63eef7e`), Score-Threshold (`493f6bf`), Docker-Deploy (`63431bd`). 144/144 Server- + 10/10
>   Bot-Tests grün. Version auf `2.1.0` gebumpt, TODO.md aktualisiert (Housekeeping-Commit); der
>   `v2.1.0`-Tag folgt erst nach dem PR-Merge auf `main`.
> - ⏭️ **Nächster Schritt** — Live-Verify (siehe „Danach"-Abschnitt unten) + Web-UI-Rest (Schritt 3).

## Befund-Zusammenfassung

| Strang | Branch | Code-Stand | Kompatibilität mit main |
|---|---|---|---|
| Cloud-Finalize | `fix/finalize-cloud-dataflow` | **komplett** (C1–C4), 140 Tests grün | **fast-forward** — merge-base == main HEAD, keine Konflikte |
| RAG (Phase 4) | `claude/rag-service-phase-4-bml2jq` | Kern komplett, Integration fehlt | 86 Commits hinter main; 1 trivialer Konflikt (`control.js`-Imports); async-Umbau von `getCampaignContext` mergt sauber |
| Web-UI | — (alles bereits in main) | **komplett** | n/a |

Wichtig fürs Sequencing: Der Finalize-Branch fasst **keine** Web-UI-Dateien an
(nur additiv `configCatalog.js` — die vier neuen Panel-Keys erscheinen nach dem
Merge automatisch im Settings-Panel). Der RAG-Branch kollidiert mit keinem der
beiden anderen Stränge. Alle drei sind parallel bzw. nacheinander ohne
Überschneidung abschließbar.

---

## Schritt 1 — `fix/finalize-cloud-dataflow` mergen ✅ *(erledigt, `c4501b9`)*

Gemergt (no-ff, keine Datei-Konflikte), 140 Tests grün. Inhalt:

- **C1** `docker-entrypoint.sh`: chown `/data`-Mounts, dann Privilegien-Drop → fixt `EACCES`
- **C2** HTTP-Upload (`finalizeHttp.js`, `PUT /finalize/upload/…`) ersetzt scp als Default; `FINALIZE_UPLOAD_CMD` bleibt LAN-Opt-out
- **C3** Archiv-Rückholung zum Bot-Host (`archivePuller.js`, sha256-verifiziert, Retention-Pruning)
- **C4** Config-Panel-Keys + Doku

**Noch offen (reine Betriebsarbeit, nächster Test-Slot):**
Live-Verifikationsmatrix Punkte 4–9 aus dem GPU-Plan-Doc — echte Session,
`/finalize run`, `~/archive/<name>/` auf dem Bot-Host prüfen, LAN-Profil-Regression.

## Schritt 2 — RAG-Branch rebasen und integrieren *(1 Coding-Session)*

Kernlogik (`apps/rag/server.py`, `ragClient.js`, `sessionBriefing.js`,
async-`getCampaignContext` mit CAMPAIGN.md-Fallback) ist fertig und getestet —
**keine Neuimplementierung nötig**. Restaufwand in Prioritätsreihenfolge:

1. **Rebase auf main** (nach Schritt 1). Ein Konflikt: `control.js`-Import-Block —
   beide Ketten behalten (`maybeFold`/`appendLive` von main **und** `maybeSessionBriefing` vom Branch).
2. **configCatalog.js**: die 5 neuen Env-Vars registrieren (`RAG_URL`, `RAG_TIMEOUT_MS`,
   `RAG_BRIEFING_ENABLED`, `RAG_BRIEFING_TOP_K`, `RAG_BRIEFING_POST_CHAT`) — Gruppe
   „Server · Live- & Kampagnen-Kontext"; `config_state`-Report in `control.js` um RAG-Felder ergänzen.
   Katalog-Contract ist verpflichtend, sonst fehlen die Keys im Settings-Panel.
3. **Deploy**: `apps/rag/Dockerfile` schreiben, auskommentierten `rag`-Service-Block in
   `deploy/docker-compose.yml` aktivieren (Platzhalter existiert schon, `RAG_URL` wird
   bereits durchgereicht), `deploy/.env.example` ergänzen, Vault-Volume-Mount (ro) analog `campaign`.
4. **Score-Threshold** für `POST /query` (fehlendes Spec-Item aus `obsidian-per-query`):
   kleiner Patch in `server.py` + `RAG_SCORE_THRESHOLD` + Katalog-Eintrag.
5. *Optional, niedrige Prio*: RAG-Query parallel zu STT/LLM statt sequenziellem await
   (fail-soft + 800-ms-Timeout machen es funktional unkritisch); pytest für `server.py`
   (Chunking/Frontmatter/Endpunkte — aktuell 0 Python-Testabdeckung).

## Schritt 3 — Web-UI abschließen *(LAN-Session + Kleinkram)*

Das UI selbst ist funktional vollständig (SSE-Live-Rendering, Settings-Panel mit
Override-Layer, Session-Picker, Debug-Modus, Basic-Auth, keine offenen TODOs im Code).
Was „fertig" noch bedeutet:

1. ✅ **R7 — nginx-Reverse-Proxy auf dem Bot-Host** erledigt (vom User bestätigt).
2. **TODO.md-Klärung `/config`-Slash-Command**: Das Web-Settings-Panel deckt Persistenz,
   Live-Apply und Bot-Ist-Wert bereits ab. Entscheidung: Eintrag als „durch Web-Panel
   ersetzt" streichen, oder bewusst als Voice-Channel-Quick-Access (ohne Browser)
   umdefinieren. → Empfehlung: streichen; `/config debug on|off` (Ephemeral-Debug)
   als einzigen verbleibenden Discord-seitigen Punkt behalten.
3. *Optional*: Client-seitiger Smoke-Test für `settings.js`/`app.js` (aktuell nur
   Server-Tests + manuelles `tests/ui-sim.mjs`).
4. Housekeeping R6/R8: altes Startup-Script + gemergte Branches löschen, privaten
   Key lokal löschen, Lizenzentscheidung.

## Empfohlene Reihenfolge

```
1. fix/finalize-cloud-dataflow mergen        (5 min, fast-forward, sofort)
2. RAG-Session: Rebase + Punkte 2.1–2.4      (eine Coding-Session)
3. Nächster Test-Slot (LAN): Live-Verify
   Finalize-Matrix 4–9 + RAG end-to-end
   + R7 Reverse-Proxy in derselben Session
4. TODO/Housekeeping (2.5, 3.2–3.4)          (Doku-Session, trivial)
```

Nach 1–3 sind alle drei Stränge produktiv nutzbar; Schritt 4 ist Politur.
Versionierung: Schritt 2 (RAG) abschließend als **v2.1.0** taggen
(Phase 4 abgeschlossen), Web-UI-Rest ist patch-level.

---

## ▶️ NÄCHSTE CODING-SESSION: RAG integrieren (Schritt 2)

Ziel: `claude/rag-service-phase-4-bml2jq` auf aktuellen main bringen und die
Integrationslücken schließen. **Die Kernlogik ist fertig und getestet — keine
Neuimplementierung.** Branch ist 86 Commits hinter main (merge-base `f57cb15`).

Was der Branch mitbringt (bereits fertig, nur mergen):
- `apps/rag/server.py` — FastAPI + ChromaDB + Ollama-`nomic-embed-text`,
  Frontmatter-Parsing, `##`-Chunking, watchdog-Filewatcher, `POST /index` · `/query` · `GET /health`
- `apps/server/src/ragClient.js` — fail-soft HTTP-Client (`queryRag`, `ragEnabled`), `RAG_TIMEOUT_MS` Default 800 ms
- `apps/server/src/campaignContext.js` — `getCampaignContext(query)` **sync→async**, RAG mit CAMPAIGN.md-Fallback
- `apps/server/src/sessionBriefing.js` — `/join`-Briefing als `system`-Message + optionaler Discord-Post
- JS-Tests: `ragClient.test.js`, `sessionBriefing.test.js`, aktualisierter `campaignContext.test.js` (alle async-korrekt)

### Checkliste (in Reihenfolge)

- [x] **1. Merge** `claude/rag-service-phase-4-bml2jq` auf aktuellen main geholt.
  **Korrektur gegenüber dem Plan:** Es war **kein Rebase** — der Branch wurde per
  Merge-Commit (`081809d`) auf den aktuellen main-Stand geholt.
  - Der erwartete Konflikt trat wie vorhergesagt genau in `apps/server/src/control.js`
    auf (Import-/Callback-Block) und wurde wie geplant aufgelöst: **beide Ketten**
    behalten — main behält `maybeFold`/`appendLive` (Live-Chunk-Update), der Branch
    bringt `maybeSessionBriefing` mit; im `session_start`-Handler laufen nach
    `rebuildLiveContext` beide Aufrufe.
  - `pipeline.js`/`campaignContext.js` mergten textuell sauber (nur Kommentar-Drift).
    Semantik verifiziert: `buildSystemBlocks` ist async und awaitet
    `getCampaignContext` korrekt — einziger Call-Site.
- [x] **2. configCatalog.js** — die RAG-Env-Vars registriert (Gruppe
  „Server · Live- & Kampagnen-Kontext", wo schon `CAMPAIGN_CONTEXT_*`/`OBSIDIAN_VAULT_PATH` stehen):
  `RAG_URL`, `RAG_TIMEOUT_MS`, `RAG_BRIEFING_ENABLED`, `RAG_BRIEFING_TOP_K`, `RAG_BRIEFING_POST_CHAT`,
  `RAG_SCORE_THRESHOLD` — Commit `63eef7e`. `config_state`-Report in `control.js` um die
  RAG-Felder ergänzt (Bot-Parität).
- [x] **3. Deploy** — RAG in den Stack — Commit `63431bd`:
  - `apps/rag/Dockerfile` geschrieben (non-root `app`-User, setpriv-Privilegien-Drop
    analog zum Server-Container).
  - `rag`-Service-Block in `deploy/docker-compose.yml` aktiviert (Vault-Volume ro,
    eigenes `rag-chroma`-Volume, Healthcheck; kein GPU-Passthrough — Embeddings laufen
    über den `ollama`-Service per HTTP).
  - `server`-environment um `RAG_TIMEOUT_MS`/`RAG_BRIEFING_*`/`RAG_SCORE_THRESHOLD` ergänzt.
  - `deploy/.env.example`: alle `RAG_*`-Vars dokumentiert/defaultet (`RAG_URL` →
    `http://rag:5001`).
  - `deploy/scripts/start.sh`: pullt zusätzlich `RAG_EMBED_MODEL` in die Ollama-Instanz.
- [x] **4. Score-Threshold** für `POST /query` (fehlendes Spec-Item aus `obsidian-per-query`)
  — Commit `493f6bf`: `server.py` filtert Top-K-Treffer nach Cosine-Distanz
  (`_apply_threshold`, pure/testbar ohne FastAPI/Chroma); `RAG_SCORE_THRESHOLD`-Env +
  per-Request-Override (`score_threshold`) + Katalog-Eintrag; `ragClient.js` hängt den
  Threshold nur an, wenn konfiguriert.
- [x] **5. Tests grün** — `npm install` im Root, dann `node --test` in `apps/server`
  (144/144) und `apps/bot` (10/10). Alle grün inkl. der neuen RAG-/Score-Threshold-Tests.
- [x] **6. Version-Bump** auf `2.1.0` (Bot + Server `package.json`, `package-lock.json`
  nachgezogen), TODO.md Phase-4-Einträge auf `[x]` gesetzt (Housekeeping-Commit).
  **`v2.1.0`-Tag folgt erst nach dem PR-Merge auf `main`** — noch nicht gesetzt.

### Optional / niedrige Priorität (nicht blockierend)
Bewusst **nicht** Teil dieser Session (Housekeeping-Commit betrifft nur Version/TODO/Doku):
- [ ] RAG-Query parallel zu STT/LLM statt sequenziellem `await` (fail-soft + 800-ms-Timeout
  machen die Sequenzialität funktional unkritisch — nur Latenz-Politur).
- [ ] pytest für `apps/rag/server.py` (Chunking/Frontmatter/Endpunkte — aktuell 0 Python-Coverage).

### Danach: Live-Verify im nächsten Test-Slot (LAN/Cloud)
- Finalize-Matrix 4–9 (echte Session → `/finalize run` → `~/archive/<name>/` prüfen, LAN-Profil-Regression).
- RAG end-to-end: `ollama pull nomic-embed-text`, Vault indexieren, Wake-Word-Query mit Vault-Treffer, `/join`-Briefing.
