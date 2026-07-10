# Plan: Cloud-Finalize, Web-UI und RAG fertigstellen

Stand: 2026-07-10, main @ `9415ae8` (v2.0.0). Basiert auf einer Drei-Branch-Analyse
(Kompatibilität + Vollständigkeit) von `fix/finalize-cloud-dataflow`,
`claude/rag-service-phase-4-bml2jq` und dem Web-UI-Reststand laut
[`fix-gpu-deployment-and-webui-merge.md`](fix-gpu-deployment-and-webui-merge.md).

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

## Schritt 1 — `fix/finalize-cloud-dataflow` mergen *(sofort, kein Risiko)*

Der Branch ist fast-forward-mergebar, ohne offene TODOs, mit neuen Tests
(`archivePuller.test.js`, `finalizeHttp.test.js`). Inhalt:

- **C1** `docker-entrypoint.sh`: chown `/data`-Mounts, dann Privilegien-Drop → fixt `EACCES`
- **C2** HTTP-Upload (`finalizeHttp.js`, `PUT /finalize/upload/…`) ersetzt scp als Default; `FINALIZE_UPLOAD_CMD` bleibt LAN-Opt-out
- **C3** Archiv-Rückholung zum Bot-Host (`archivePuller.js`, sha256-verifiziert, Retention-Pruning)
- **C4** Config-Panel-Keys + Doku

**Nach dem Merge offen (reine Betriebsarbeit, nächster Test-Slot):**
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

1. **R7 — nginx-Reverse-Proxy auf dem Bot-Host** (`bot-host:7440 → 10.10.0.2:7440`,
   SSE braucht `proxy_buffering off`); vorher Basic-Auth-Credentials rotieren
   (Default `greyhawk`/`greyhawk` nicht veröffentlichen). *Nur vom LAN aus machbar.*
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
Versionierung: Merge von Schritt 1+2 zusammen als **v2.1.0** taggen
(Phase 4 abgeschlossen), Web-UI-Rest ist patch-level.
