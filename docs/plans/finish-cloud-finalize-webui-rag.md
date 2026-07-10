# Plan: Cloud-Finalize, Web-UI und RAG fertigstellen

Stand: 2026-07-10, main @ `c4501b9`. Basiert auf einer Drei-Branch-Analyse
(Kompatibilität + Vollständigkeit) von `fix/finalize-cloud-dataflow`,
`claude/rag-service-phase-4-bml2jq` und dem Web-UI-Reststand laut
[`fix-gpu-deployment-and-webui-merge.md`](fix-gpu-deployment-and-webui-merge.md).

> **Fortschritt:**
> - ✅ **Schritt 1** — `fix/finalize-cloud-dataflow` gemergt (`c4501b9`), 140 Tests grün. Offen: nur Live-Verify auf echter Instanz.
> - ✅ **R7** — nginx-Reverse-Proxy fürs Web-UI erledigt (vom User bestätigt).
> - ⏭️ **Nächste Coding-Session: Schritt 2 (RAG)** — siehe Detail-Checkliste unten.

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

- [ ] **1. Rebase** `claude/rag-service-phase-4-bml2jq` auf aktuellen main.
  - Einziger Konflikt: `apps/server/src/control.js` Import-/Callback-Block.
    Beide Ketten behalten: main hat `maybeFold`/`appendLive` (Live-Chunk-Update),
    Branch fügt `maybeSessionBriefing` hinzu. Im `session_start`-Handler nach
    `rebuildLiveContext` **beide** Aufrufe verdrahten.
  - `pipeline.js`/`campaignContext.js` mergen textuell sauber (nur Kommentar-Drift).
    Semantik verifizieren: main ruft `getCampaignContext` synchron in
    `buildSystemBlocks` (nicht async) — der Branch macht beide async. Einziger
    Call-Site, also sauber; nach Rebase `buildSystemBlocks` = async lassen und
    den `await` prüfen.
- [ ] **2. configCatalog.js** — die 5 RAG-Env-Vars registrieren (Gruppe
  „Server · Live- & Kampagnen-Kontext", wo schon `CAMPAIGN_CONTEXT_*`/`OBSIDIAN_VAULT_PATH` stehen):
  `RAG_URL`, `RAG_TIMEOUT_MS`, `RAG_BRIEFING_ENABLED`, `RAG_BRIEFING_TOP_K`, `RAG_BRIEFING_POST_CHAT`.
  Contract ist verpflichtend — ohne Katalog-Eintrag erscheinen sie nicht im Settings-Panel.
  Zusätzlich `config_state`-Report in `control.js` (~Z.95) um die RAG-Felder ergänzen (Bot-Parität).
- [ ] **3. Deploy** — RAG in den Stack:
  - `apps/rag/Dockerfile` schreiben (existiert noch nicht; Compose-Kommentar referenziert ihn).
  - Auskommentierten `rag`-Service-Block in `deploy/docker-compose.yml` aktivieren
    (`RAG_URL` wird bereits an den `server`-Service durchgereicht).
  - `server`-environment um `RAG_TIMEOUT_MS`/`RAG_BRIEFING_*` ergänzen.
  - `deploy/.env.example`: `RAG_VISIBLE_DEVICES`, `RAG_TIMEOUT_MS`, `RAG_BRIEFING_*`.
  - Vault-Volume read-only in den RAG-Container mounten (analog `campaign:/data/campaign:ro`).
- [ ] **4. Score-Threshold** für `POST /query` (fehlendes Spec-Item aus `obsidian-per-query`):
  `server.py` filtert Top-K nach Distanz; `RAG_SCORE_THRESHOLD`-Env + Katalog-Eintrag.
- [ ] **5. Tests grün** — `npm install` (Workspace-`node_modules` fehlen im frischen Container!),
  dann `node --test` in `apps/server` und `apps/bot`. Ziel: alle grün inkl. der neuen RAG-Tests.
- [ ] **6. Version-Bump** auf `2.1.0` (Bot + Server `package.json`), TODO.md Phase-4-Einträge
  auf `[x]` setzen, `v2.1.0` taggen.

### Optional / niedrige Priorität (nicht blockierend)
- [ ] RAG-Query parallel zu STT/LLM statt sequenziellem `await` (fail-soft + 800-ms-Timeout
  machen die Sequenzialität funktional unkritisch — nur Latenz-Politur).
- [ ] pytest für `apps/rag/server.py` (Chunking/Frontmatter/Endpunkte — aktuell 0 Python-Coverage).

### Danach: Live-Verify im nächsten Test-Slot (LAN/Cloud)
- Finalize-Matrix 4–9 (echte Session → `/finalize run` → `~/archive/<name>/` prüfen, LAN-Profil-Regression).
- RAG end-to-end: `ollama pull nomic-embed-text`, Vault indexieren, Wake-Word-Query mit Vault-Treffer, `/join`-Briefing.
