# Live-Transkript als LLM-Kontext + Rolling-Summary + Kampagnen-Kontext · Implementierungsplan (v2)

> Liefert drei zusammenhängende TODO-Items: „Transkript als LLM-Kontext", „session-rolling-summary"
> (beide aus _Optimierungen_) und die **statische** Variante A von Phase 4 (`obsidian-per-query`,
> ohne RAG-Service).
> Versionsziel am Ende: `1.4.0`. Branch-Vorschlag: `feature/live-transcript-llm-context`.
>
> **v2** = optimiert nach Review eines Alternativplans (siehe Abschnitt „Bewertung Alternativplan").

## Kernidee (Recap)

Transkribiert wird bereits live in `runPipeline` ([pipeline.js:512](../apps/server/src/pipeline.js)).
Jede Äußerung erzeugt ein `user_transcript`-Event ([pipeline.js:551](../apps/server/src/pipeline.js)),
jede LLM-Antwort ein `assistant_response`-Event ([pipeline.js:414](../apps/server/src/pipeline.js)) —
heute fürs LLM verworfen, sobald kein Wake-Word getroffen wurde. Wir **berechnen nichts Neues**,
sondern halten das bereits Berechnete im RAM, ordnen es und reichen es kompakt an `chat()`. Keine
zusätzliche STT-Last.

## Bewertung Alternativplan (was übernommen / verworfen wird)

Der Alternativplan entstand **vor** dem letzten PR (Phase-3-Finalize). Seine drei „Korrekturen" sind
inzwischen erledigt und werden **ignoriert**:

| Annahme des Alternativplans | Realität (post-PR) |
|---|---|
| `merge.js` / `normalizeText` / `isBracketOnly` / `speakerLabel` fehlen → neu schreiben | **Existieren** in [merge.js](../apps/server/src/finalize/merge.js) und sind exportiert → **wiederverwenden**. |
| `loadSpeakerMap` fehlt | **Existiert** ([speakerMap.js](../apps/server/src/speakerMap.js)). |
| Bot sendet keinen `displayName`; Bot+Protokoll erweitern (Sektion 8) | Bot sendet `userDisplayName`/`startTsMs`/`endTsMs` **bereits** ([transport/control.js:127](../apps/bot/src/transport/control.js)) → **kein Bot-Eingriff nötig**. |
| Assistant-Antworten landen nicht im JSONL (Sektion 9) | `assistant_response` wird **bereits** geloggt ([pipeline.js:414](../apps/server/src/pipeline.js)). |
| Server hat nur `Date.now()`, keinen Sprech-Start | `user_transcript` trägt `startTsMs` (Bot-Uhr) → echte Reihenfolge nutzbar. |

**Übernommene Verbesserungen** (besser als v1 dieses Plans):

1. **Harter Render-Cap `LIVE_RENDER_MAX_CHARS`** auf dem gerenderten Live-Block, **von hinten gekürzt
   (jüngste Zeilen gewinnen)** — Gürtel-und-Hosenträger gegen Prompt-Blowup **unabhängig** vom Fold-Stand.
2. **`SUMMARY_MAX_CHARS`** — die Rolling-Summary selbst deckeln, damit sie nicht unbegrenzt wächst.
3. **Optionaler `SUMMARY_MODEL`-Override** (leer = `OLLAMA_MODEL`, also Vorgabe „selbes Modell") — harmlose
   Zukunftsfestigkeit ohne Verhaltensänderung.
4. **Crash-sicheres Falten: Segment erst NACH erfolgreichem `summarize()` aus dem Buffer entfernen**
   (statt vorher entfernen + bei Fehler zurückrollen). Sauberer, kein Rollback-Race, kein Datenverlust
   bei Crash mitten im Fold.

## Vorgaben des Users

1. **Summary-Modell**: gleiches Ollama-Modell (`OLLAMA_MODEL`); optionaler `SUMMARY_MODEL`-Override.
2. **Kampagnen-Kontext**: Variante A (statische `CAMPAIGN.md`), kein RAG. Signatur `getCampaignContext(query?)` zukunftsfest.
3. **Schwellen**: Roh-Fenster ~6 000 Zeichen, Fold ~3 000 Zeichen.
4. **Persistenz**: nur RAM; **bei Resume aus JSONL neu aufbauen**.
5. **Scope**: **alle** Sprecher-Äußerungen ins LLM.

## Architektur-Überblick

```
runPipeline ──┐ (user_transcript, ALLE Sprecher)
              ├──> appendLive(session, {label, text, startMs, kind})
answerQuestion┘ (assistant_response)            │
                                                ├─ windowChars > LIVE_RAW_WINDOW_CHARS ?
                                                └─> maybeFold ─► summarize() (async, single-flight,
                                                                  remove-after-success)

Wake-Word-Query ─► answerQuestion ─► chat(history, query, { systemBlocks: [
    "Kampagnen-Kontext:\n…",      // getCampaignContext()   (Variante A, gecached)
    "Bisherige Zusammenfassung:\n…", // session.liveContext.summary
    "Letztes Live-Transkript:\n…",   // renderForLlm(buffer, LIVE_RENDER_MAX_CHARS)
]})
```

Drei getrennte `system`-Blöcke zwischen Basis-System-Prompt und History (statisch → grob → fein),
jeder unabhängig budgetierbar.

## Neue / geänderte Dateien

| Datei | Art | Inhalt |
|---|---|---|
| `apps/server/src/liveContext.js` | **neu** | Stateful Buffer/Summary-State; **pure** `renderForLlm()` + Fold-Helper. |
| `apps/server/src/campaignContext.js` | **neu** | Variante A: liest/cached `CAMPAIGN.md`, kürzt auf Budget. |
| `apps/server/src/rollingSummary.js` | **neu** | `summarize(prev, segment)` gegen Ollama; Summary-Prompt. |
| `apps/server/src/sessionEvents.js` | **neu** | `readSessionEvents(sessionId)` (aus `control.js` extrahiert) — geteilt für Resume. |
| `apps/server/src/state.js` | ändern | Session-Objekt um `guildId/guildName/channelName` + `liveContext` erweitern. |
| `apps/server/src/pipeline.js` | ändern | Buffer-Hooks; `chat()` mit `systemBlocks`. |
| `apps/server/src/llm.js` | ändern | `chat(history, query, { systemBlocks })`. |
| `apps/server/src/control.js` | ändern | `session_start`: guildId auf Session stashen; Resume-Rebuild; `readSessionEvents` importieren. |
| `apps/server/test/liveContext.test.js` | **neu** | Serializer + Render-Cap + Fold-Trigger + Single-Flight (pure). |
| `apps/server/test/campaignContext.test.js` | **neu** | Lesen/Cachen/Truncation. |

---

## Milestones

### M0 — Session-State & guildId-Plumbing
- **M0.1** `state.js`: Session-Objekt um `guildId`, `guildName`, `channelName`, `liveContext` erweitern;
  `ensureSession` legt `liveContext` leer an.
- **M0.2** `control.js` `session_start` ([control.js:249](../apps/server/src/control.js)): nach
  `ensureSession` `s.guildId/s.guildName/s.channelName` aus `msg` schreiben. `logSessionMeta` unverändert.
- **M0.3** Damit ist `loadSpeakerMap(session.guildId)` im Pipeline-Pfad verfügbar (Label-Auflösung via
  `speakerLabel`).

### M1 — Live-Buffer (`liveContext.js`)
Trennung **stateful** (Buffer pro Session) vs. **pure** (Serializer/Cap/Fold, unit-testbar).

- **M1.1** State (von `ensureSession` angelegt):
  ```js
  liveContext: {
    buffer: [],         // { label, text, startMs, kind:'user'|'assistant' }
    summary: '',        // rolling summary (Klartext)
    summarizing: false, // single-flight guard
    rebuilt: false,     // Resume-Rebuild bereits gelaufen?
  }
  ```
- **M1.2** `appendLive(session, { label, text, startMs, kind })`:
  - `normalizeText` + `isBracketOnly` aus `merge.js` wiederverwenden → leere/Bracket-Only-Einträge droppen.
  - **Sortiert nach `startMs`** einfügen (Insertion am Ende; async-STT verdreht selten).
  - danach `maybeFold(session)` (M4).
- **M1.3** `renderForLlm(buffer, maxChars) → string` (**pure**): kompaktes Klartext-Format, **von hinten
  auf `maxChars` begrenzt** (jüngste Zeilen gewinnen). Keine Marker/Timestamps:
  ```
  [Hauke] Ich glaube wir gehen nach links.
  [Greta] Nee, rechts war der Gang.
  [Rabenauge] Dahinter lag der dunkle Gang …
  ```
- **M1.4** Hook 1 in `runPipeline` nach dem `user_transcript`-Log
  ([pipeline.js:551](../apps/server/src/pipeline.js)): **jede** Äußerung anhängen (Vorgabe 5). Label via
  `speakerLabel(userId, metadata.userDisplayName, loadSpeakerMap(session.guildId))`,
  `startMs = metadata.startTsMs ?? Date.now()`, `kind:'user'`.
- **M1.5** Hook 2 in `answerQuestion` nach dem `assistant_response`-Log
  ([pipeline.js:414](../apps/server/src/pipeline.js)): `label = wakeWordName()`, `kind:'assistant'`,
  `startMs = Date.now()`. **Nur** bei `sid` (Voice-Session); sessionless/Text hat keinen Buffer.
- **Tests**: `renderForLlm` Reihenfolge/Bracket-Drop/Label/Whitespace; **Render-Cap kürzt von hinten**;
  Insertion bei vertauschten `startMs`.

### M2 — Kampagnen-Kontext (Variante A, `campaignContext.js`)
- **M2.1** Config: `OBSIDIAN_VAULT_PATH`, `CAMPAIGN_CONTEXT_FILE` (Default `CAMPAIGN.md`),
  `CAMPAIGN_CONTEXT_MAX_CHARS` (Default 6 000 ≈ 1 500 Tokens).
- **M2.2** `getCampaignContext(query = null) → string`: liest die Datei, **cached mit `mtime`-Check**
  (Edits greifen ohne Neustart), kürzt auf das Budget (Wort-/Zeilenende). Fehlt Datei/Config → `''`.
  `query` aktuell ignoriert (RAG-Hook für später).
- **Tests**: vorhanden→gelesen+gekürzt; fehlend→`''`; Cache invalidiert bei geänderter `mtime`.

### M3 — Kontext-Zusammenbau in `chat()` / `answerQuestion`
- **M3.1** `llm.js`: `chat(history, query, { systemBlocks = [] } = {})`:
  ```js
  const messages = [
    { role:'system', content: LOADED_SYSTEM },
    ...systemBlocks.filter(Boolean).map(content => ({ role:'system', content })),
    ...recentHistory,
    { role:'user', content: query },
  ];
  ```
  Reihenfolge: **Kampagne → Summary → Live-Transkript**. Default `[]` = heutiges Verhalten (abwärtskompat.).
- **M3.2** `answerQuestion` baut die Blöcke (nur bei `sid`):
  - `getCampaignContext()` → `Kampagnen-Kontext:\n…`
  - `session.liveContext.summary` → `Bisherige Zusammenfassung:\n…` (nur wenn nicht leer)
  - `renderForLlm(session.liveContext.buffer, LIVE_RENDER_MAX_CHARS)` → `Letztes Live-Transkript:\n…`
  - Leere Blöcke entfallen. Sessionless/Text → `systemBlocks` leer.
- **M3.3** Doppelung: Die Wake-Äußerung steht via `user_transcript` schon im Buffer **und** als `query`
  — akzeptabel (Anker fürs Modell), in M3 kommentieren.

### M4 — Rolling-Summary (`rollingSummary.js`, async + single-flight + remove-after-success)
- **M4.1** `maybeFold(session)` (**pure** Trigger in `liveContext.js`): wenn `LIVE_CONTEXT_ENABLED` **und**
  `windowChars(buffer) > LIVE_RAW_WINDOW_CHARS` (6 000) **und** `!summarizing`:
  - die ältesten Einträge bis ~`LIVE_FOLD_CHARS` (3 000) als `segment` **per Referenz** auswählen
    (noch **nicht** entfernen),
  - `summarizing = true` (single-flight → schützt Wake-Latenz),
  - **fire-and-forget** `foldIntoSummary(session, segment)`:
    - `summary = await summarize(session.liveContext.summary, renderForLlm(segment, Infinity))`
    - **Erfolg**: `summary` (auf `SUMMARY_MAX_CHARS` getrimmt) setzen; `segment`-Einträge **per Identität**
      aus dem Buffer entfernen (`buffer = buffer.filter(e => !segSet.has(e))`); `summarizing = false`.
    - **Fehler**: nur `summarizing = false`, `warn` — `segment` bleibt im Buffer (Retry beim nächsten Append).
- **M4.2** `summarize(prevSummary, newSegment) → Promise<string>`: Ollama-`/api/chat` gegen
  `SUMMARY_MODEL || OLLAMA_MODEL`, `stream:false`, **inkl. Kampagnen-Kontext** als System-Block (Eigennamen).
  Plain-Text (kein JSON-Parsing).
- **M4.3** Summary-Prompt (Konstante):
  > „Du fasst das Live-Transkript eines Sprach-Chats einer Pen-&-Paper-/D&D-Runde zusammen. Viel
  > Meta-/Off-Topic-Gerede. Extrahiere spielrelevante Ereignisse, Entscheidungen, Orte, NPCs und offene
  > Fragen — knapp. Ignoriere Privates/Technik-Geplänkel. Eigennamen exakt beibehalten, Vergangenheitsform,
  > neutral. Aktualisiere die bisherige Zusammenfassung mit dem neuen Segment, ohne Wichtiges zu verlieren."

  Input: `Bisherige Zusammenfassung:\n{prev}\n\nNeues Segment:\n{segment}`.
- **M4.4** `maybeFold` nie awaiten. Wake-Pfad nutzt die **aktuelle** Summary; noch nicht gefaltetes Segment
  liegt weiter im Roh-Fenster → kein Informationsverlust. Optionaler Mindestabstand
  `LIVE_FOLD_MIN_INTERVAL_MS` gegen Dauerlast.
- **Tests**: Fold-Trigger-Grenzen; Segment-Auswahl ~3 000 an Eintragsgrenzen; **Single-Flight-Guard**;
  **remove-after-success** entfernt genau das Segment (Fake-`summarize`); Fehler lässt Buffer unverändert.

### M5 — Resume-Rebuild aus JSONL (Vorgabe 4)
- **M5.1** `readSessionEvents` aus `control.js` ([control.js:130](../apps/server/src/control.js)) in
  `sessionEvents.js` extrahieren (geteilt mit Finalize). Verhalten unverändert.
- **M5.2** `rebuildLiveContext(session, sessionId)` (einmalig, `!liveContext.rebuilt`):
  `readSessionEvents` → `buildModelFromEvents(events, { speakerMap })` (aus `merge.js`) → chronologische
  Spans → Buffer-Einträge (`{label, text, startMs: span.startMs, kind}`).
  **Entscheidung:** den gesamten Verlauf sofort in **eine** Summary falten und nur das jüngste
  ~`LIVE_RAW_WINDOW_CHARS`-Fenster als Roh-Buffer behalten → resumte Mehrstunden-Session startet nicht mit
  Riesen-Roh-Fenster. `rebuilt = true`.
- **M5.3** Aufruf in `control.js` `session_start` bei `msg.resume` (oder Buffer leer & JSONL vorhanden).
  Fire-and-forget; blockiert `ack` nicht.

### M6 — Config, Telemetrie, Doku, Version
- **M6.1** Env-Vars in README dokumentieren + in `logSessionMeta` (`control.js`, Block `llm`) spiegeln.
- **M6.2** Master-Flag `LIVE_CONTEXT_ENABLED` (Default `true`); aus → Hooks/Render no-op, `systemBlocks` leer.
- **M6.3** `apps/server/package.json` → `1.4.0`; TODO.md-Items abhaken/verlinken.

### M7 — `CAMPAIGN.md` aus dem Obsidian-Vault generieren (Claude-Cowork-Prompt)
Variante A braucht eine gepflegte `CAMPAIGN.md`. Statt sie von Hand zu schreiben, wird sie aus dem
bestehenden Vault generiert.

- **Cowork-Projekt**: `C:\Users\nogar\Programme\Claude\Greyhawk Campaign Claude` (= zugleich der
  Obsidian-Vault; strukturiertes Frontmatter `type`/`disposition`/`faction`/`location`/`status`/`session_num`
  in `20_Party`, `30_NPCs`, `40_World`, `10_Campaign/Quests` + `Session Notes`/`Chronicles`).
- **Ziel-Datei**: `CAMPAIGN.md` im Vault-Wurzelverzeichnis (= `OBSIDIAN_VAULT_PATH` /
  `CAMPAIGN_CONTEXT_FILE`).
- **Budget-Hinweis**: `getCampaignContext` kürzt bei Überlänge **von vorne behaltend** (Tail wird
  abgeschnitten) auf `CAMPAIGN_CONTEXT_MAX_CHARS` (6 000). Darum: **Wichtigstes zuerst**, Gesamtlänge
  ≤ ~5 500 Zeichen halten, damit nichts Relevantes wegfällt.
- **Wiederholbar**: Der Prompt ist als Skill/Routine nach jeder Session erneut ausführbar (regeneriert
  Plot-Stand + Last-Session-Recap). Passt zur bestehenden `session-einpflegen`-Pipeline des Vaults.

**Fertiger Prompt (in Cowork einfügen):**

> Du arbeitest im Obsidian-Vault dieser Greyhawk-D&D-Kampagne. Erzeuge bzw. überschreibe die Datei
> `CAMPAIGN.md` im Vault-Wurzelverzeichnis. Sie dient als **Kontext für einen Sprach-Assistenten namens
> Rabenauge**, der während der laufenden Pen-&-Paper-Session per Wake-Word Fragen der Spieler beantwortet.
> Der Assistent sieht **nur diese eine Datei** als Kampagnen-Wissen — sie muss also eigenständig,
> aktuell und extrem kompakt sein.
>
> **Quellen (lies sie aus, fasse zusammen — nicht kopieren):**
> - `20_Party/Characters` (PCs, `type: PC`) und `20_Party/Sidekicks` (Gefährten) — wer ist die Party.
> - `30_NPCs` (`type: NPC`) — priorisiere nach Wichtigkeit: am häufigsten verlinkte NPCs zuerst, dann
>   nach `disposition` (Friendly/Hostile/Neutral). Nimm nur die **relevantesten ~15**, nicht alle.
> - `40_World/Locations` und `40_World/Factions` — nur die für den aktuellen Plot relevanten.
> - `10_Campaign/Quests` mit `status: Active` — laufende Aufträge inkl. Auftraggeber/Ort.
> - Die **jüngste** Session-Notiz/Chronik in `10_Campaign/Session Notes` bzw. `Chronicles`
>   (höchste `session_num`) — für den „Stand jetzt"-Abschnitt.
> - `00_Dashboard.md` für die schnellen Fakten (Hauptfraktionen etc.).
>
> **Format der `CAMPAIGN.md` (genau diese Reihenfolge, Wichtigstes oben):**
> 1. `# Kampagnen-Kontext` + ein Einzeiler, welche Kampagne/Welt (Greyhawk) und wo die Party gerade steht.
> 2. `## Stand jetzt` — 3–6 Sätze: was zuletzt passierte, aktuelle Lage, unmittelbares Ziel.
> 3. `## Party` — pro PC eine Zeile: `Spielername als Charaktername — Rasse/Klasse, ein prägnantes Merkmal`.
>    Danach Gefährten/Sidekicks knapp.
> 4. `## Aktuelle Quests` — pro aktive Quest eine Zeile: `Questname — Auftraggeber, Ort, offener Stand`.
> 5. `## Wichtige NPCs` — pro NPC eine Zeile: `Name — Rolle/Fraktion, Ort, Beziehung zur Party (verbündet/feindlich/neutral)`.
>    Verbündete und wichtige Antagonisten zuerst.
> 6. `## Orte & Fraktionen` — die wenigen aktuell relevanten Orte und Organisationen, je eine Zeile.
>
> **Strenge Regeln:**
> - **Reiner Klartext-Markdown.** KEINE Obsidian-`[[Wikilinks]]`, KEINE `dataview`/`dataviewjs`-Blöcke,
>   KEINE Tabellen, KEINE Callouts (`> [!…]`), KEINE Bilder/Embeds, KEIN Frontmatter.
> - **Eigennamen exakt** schreiben (Personen, Orte, Fraktionen, Götter) — der Assistent muss sie
>   wörtlich wiedererkennen und aussprechen.
> - Auf **Deutsch**, neutral, faktisch, Vergangenheits-/Präsens gemischt wie es natürlich passt.
> - **Kein Meta/DM-Geheimwissen**, das die Spieler (noch) nicht kennen sollen — nur was am Tisch
>   bekannt/sagbar ist. Im Zweifel weglassen.
> - **Gesamtlänge maximal ~5 500 Zeichen.** Lieber weniger NPCs/Orte als Abschneiden. Das Wichtigste
>   steht oben, weil bei Überlänge das Ende abgeschnitten wird.
> - Wenn ein Abschnitt leer wäre (z. B. keine aktiven Quests), kurz „—" oder den Abschnitt weglassen.
>
> Schreibe ausschließlich die Datei `CAMPAIGN.md`; gib am Ende die Zeichenanzahl aus und liste die NPCs/Quests,
> die du wegen des Budgets ausgelassen hast.

---

## Env-Vars (neu)

| Var | Default | Zweck |
|---|---|---|
| `LIVE_CONTEXT_ENABLED` | `true` | Master-Schalter (Notausschalter). |
| `OBSIDIAN_VAULT_PATH` | — | Vault-Wurzel (Variante A: nur Pfadauflösung). |
| `CAMPAIGN_CONTEXT_FILE` | `CAMPAIGN.md` | Datei mit NPCs/Orten/Plot-Stand. |
| `CAMPAIGN_CONTEXT_MAX_CHARS` | `6000` | Budget Kampagnen-Block (≈1 500 Tokens). |
| `LIVE_RAW_WINDOW_CHARS` | `6000` | Schwelle, ab der gefaltet wird. |
| `LIVE_FOLD_CHARS` | `3000` | Menge pro Fold-Schritt. |
| `LIVE_RENDER_MAX_CHARS` | `6000` | Harter Cap des gerenderten Live-Blocks (von hinten gekürzt). |
| `SUMMARY_MODEL` | _(leer = `OLLAMA_MODEL`)_ | Optionaler Override fürs Summary-Modell. |
| `SUMMARY_MAX_CHARS` | `2000` | Deckel für die Rolling-Summary. |
| `LIVE_FOLD_MIN_INTERVAL_MS` | `0` | Optionaler Mindestabstand zwischen Folds. |

## Reihenfolge

M0 → M1 (+Tests) → M2 (+Tests) → M3 (end-to-end dünn: Kontext fließt ins LLM) → M4 (+Tests)
→ M5 (Resume) → M6 (Doku/Flag/Bump) → M7 (`CAMPAIGN.md` via Cowork generieren). Nach M3 ist das
Live-Transkript bereits wirksam; Summary + Kampagne sind additive Verbesserungen. M7 kann parallel
zu M2 laufen (liefert die Datei, die M2 konsumiert) und wird nach jeder Session wiederholt.

## Testbarkeit (pure vs. live)

- **Unit (jetzt)**: `renderForLlm` inkl. Render-Cap; Fold-Trigger/Segment/Single-Flight/remove-after-success;
  `getCampaignContext` Lesen/Cachen/Truncation. (`node --test`.)
- **Nur live**: Antwortqualität mit Kontext, Summary-Prompt-Güte, Wake-Latenz unter Fold-Last →
  manuelle Checkliste analog `docs/phase-3-manual-tests.md`.

## Offene Mikro-Punkte (kein Blocker)

- M3.3: Wake-Äußerung doppelt (Buffer + `query`) lassen oder letzte Buffer-Zeile vor dem Rendern droppen.
- `startMs` der Assistant-Einträge = `Date.now()` (kein TTS-Start-Timestamp nötig; reine Reihenfolge).
- M5.2-Fold beim Resume kann initial einen großen `summarize()`-Call auslösen — akzeptabel (einmalig,
  async, blockiert `ack` nicht).
