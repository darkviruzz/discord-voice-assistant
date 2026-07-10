# Plan: fix GPU-Deployment dependencies and prepare live transcript web-UI merge

> **Status 2026-07-10:** Phase A ist erledigt (PR #11 gemergt, v2.0.0 getaggt
> und Images published) bzw. durch **PR #12** (`feat/unified-deploy`) ersetzt:
> va-CLI, Slots prod/test, dynamische Startup-Script-Registrierung pro Launch,
> Env-Layering mit Secrets in `~/.config/va/deploy.env` — verbindlicher
> Kontrakt in `docs/deploy-architecture.md`. `VERDA_STARTUP_SCRIPT_ID` und die
> manuelle Regeneration existieren nicht mehr. Offen sind: die
> **Rollout-Checkliste** unten (User, bot-host), **Phase B** (Finalize-
> Dataflow — DAS ist der Grund, warum das fertige Transkript/Archiv nach dem
> Server-Shutdown noch NICHT auf dem Bot liegt) und **Phase D**.
>
> **Beim Live-Rollout auf dem echten bot-host gefunden + gefixt** (alle vier
> PRs #13-#16 sind gemergt, Details in den Commits — hier nur damit spätere
> Sessions nicht erneut stolpern):
> - **#13**: `POST /v1/scripts` liefert die Script-ID als reinen Text statt
>   JSON (cloud-start.sh nahm fälschlich ein JSON-Objekt an) +
>   `VERDA_SSH_KEY_ID` fehlte in der `--dry-run`-Redaction.
> - **#14**: Watchdog in `transport/index.js` gate­te auf `currentSessionId`
>   (bleibt über `/leave` hinweg absichtlich gesetzt, für Session-Resume)
>   statt auf `hasActiveSession()` → re-startete `SERVER_START_CMD`
>   unbegrenzt weiter, auch lange nachdem alle den Channel verlassen hatten.
> - **#15**: `uplink: frame dropped` flutete den Log mit einer Zeile pro
>   Opus-Frame (~50/s) während der Server unreachable war — jetzt erste
>   Drop sofort geloggt, Rest alle 10s als Summary.
> - **#16**: `control.js`s `serverCommand`-Allowlist enthielt `transcript_event`
>   nicht → der fertige Handler in `transport/index.js` wurde nie erreicht,
>   Live-Transkript-Push zum bot-host lief komplett ins Leere (nur "unknown
>   msg type" geloggt). Dazu: `/join`s Timeout-Meldung blieb stehen, auch
>   wenn der Watchdog Minuten später doch noch erfolgreich verband — nutzt
>   jetzt den vorhandenen `handleServerLink`-Recovery-Pfad.
>
> **Wichtig für die nächste Session:** #14/#15/#16 ändern Bot-Code
> (`apps/bot/src/**`) — der bot-host braucht nach dem Mergen noch
> `git pull --ff-only && npm ci --omit=dev && sudo systemctl restart discord-bot`,
> sonst läuft dort weiterhin der alte Stand ohne diese Fixes.
>
> **Live bestätigt (2026-07-10):** ein kompletter Cloud-Deploy lief
> Ende-zu-Ende durch (alle 4 Container healthy, Server korrekt als v2.0.0
> geloggt, LLM-Antwort + TTS-Wiedergabe funktionierten). Repo ist jetzt
> **public** (R4/R8 unten aktualisiert), `CONTROL_BEARER` wurde bereits
> rotiert.

## Ausführungskontext für Folge-Sessions (WICHTIG zuerst lesen)

Die weitere Umsetzung passiert voraussichtlich in einer **Cloud-Instanz von
Claude Code** (arbeitet auf einem frischen Clone dieses Repos). Für die gilt:

- **Kein Zugriff** auf LAN/bot-host (192.168.20.21), Proxmox, den
  WireGuard-Tunnel oder laufende Verda-Instanzen. SSH-Schlüssel und
  `~/.config/va/deploy.env` existieren dort nicht und dürfen dort auch
  **nicht hinterlegt werden** (keine Secrets in Cloud-Sandboxes).
- Was dort GEHT: gesamte Phase B/D-Implementierung (reiner Repo-Code),
  `npm test` (117 Tests), `node --check`, `bash -n`,
  `cloud-start.sh --dry-run` (arbeitet offline, Secrets via Dummy-Datei —
  Muster: `VA_DEPLOY_ENV=/tmp/dummy.env` mit erfundenen Werten), Docker-Builds
  falls die Umgebung Docker hat.
- Was dort NICHT geht und als expliziter Rest für User/lokale Session zu
  hinterlassen ist: alles in der Verifikations-Matrix mit „bot-host/lokal".
- Branch-Konvention: neuer Branch **von `main` NACH dem Merge von PR #12**.
  Vorher lohnt kein Start (Phase B baut auf dem neuen Deploy-Weg auf).

**Arbeitsteilung:** Schritte ohne Markierung = Sonnet reicht.
`[OPUS]` = fehleranfällig/architektonisch → stärkeres Modell nehmen.

---

## Feste Fakten (NICHT neu ableiten, gelten als verifiziert)

| Was | Wert |
|---|---|
| Bot-Host | `discord-bot-jn` = 192.168.20.21, User `discordbot`, Repo `/home/discordbot/discord-voice-assistant` |
| Bot systemd-Unit | `discord-bot`, Env-File `/etc/discord-bot-verda.env` via `systemctl edit` (EnvironmentFile) |
| Proxmox | `pve-jn`, WG `10.10.0.1`, wg0.conf-Peer für Instanz-Pubkey `PgXopBtYrEHctHqF99+5vBoXIWPFkgwOI2slHdjWnVo=` |
| GPU-Instanz | immer `10.10.0.2` (Tunnel-IP fix), Hostname `va-gpu`, Server-Port 7440 |
| SSH zur Instanz | `ssh -i ~/.ssh/verda-a6000 root@<öffentliche-IP>` (Windows-Host); auf bot-host: `~/.ssh/id_verda` |
| CONTROL_BEARER | (secret — liegt in deploy/.env auf der Instanz + apps/bot/.env auf dem Bot; alter Wert stand bis 2026-07-09 im Klartext in diesem Doc → **am 2026-07-10 rotiert**, neuer Wert in apps/server/.env (Windows), apps/bot/.env + deploy.env (bot-host)) |
| Verda-Config | `~/.config/va/deploy.env` auf dem bot-host ist jetzt die Quelle (Schema in `docs/deploy-architecture.md`). Ob dort zusätzlich `GH_USER`/`GH_PAT` gesetzt sind (von einem Zwischenschritt, als das Repo noch privat war) ist NICHT verifiziert — seit das Repo public ist, ist es ohnehin optional (anonymer Clone funktioniert, live bestätigt). Alt-Bestand `/etc/discord-bot-verda.env` existiert noch als systemd-EnvironmentFile, überschreibt einzelne Keys als Prozess-Env falls dort gesetzt. `VERDA_STARTUP_SCRIPT_ID` ist obsolet (wird ignoriert). OS_IMAGE=`ubuntu-22.04-cuda-12.4-docker` (NIE bare ubuntu-22.04 — kein Docker/CUDA!) |
| Startup-Script | seit PR #12 **dynamisch pro Launch**: `cloud-start.sh` generiert + registriert via `POST /v1/scripts` (`va-<slot>-<slug>-<epoch>`) und räumt alte auf. WG-Privatekey = `VA_WG_KEY_PROD` in deploy.env (Wert stammt aus `/root/boot_private.key`) — NIE rotieren ohne Proxmox-Peer-Update |
| Slots | prod = `va-gpu`/10.10.0.2, test = `va-gpu-test`/10.10.0.3 (eigener Key `VA_WG_KEY_TEST`, Proxmox-Peer einmalig nötig); parallel betreibbar; exakter Hostname-Match überall |
| va-CLI | `deploy/va`: `local up/down/status/logs`, `remote up/down/status/logs/ssh --slot --ref`, `bot update/switch/status/logs`, `env show` (maskiert) |
| Repo-Sichtbarkeit | Seit 2026-07-10 **public** (`darkviruzz/discord-voice-assistant`) — GHCR-Packages ebenfalls public. Der PAT-lose Clone-Pfad im Startup-Script funktioniert dadurch jetzt tatsächlich (davor lief er nie erfolgreich, weil das Repo trotz "public packages" noch privat war — R4 hatte das ursprünglich vermengt) |
| Bot-Host-Stand (2026-07-10) | Auf `main`, Version läuft aktuell mit den Fixes aus #13-#16 (nach `git pull`+Restart) oder kurz davor — bei Zweifel `./deploy/va bot status` prüfen |
| DATA_DIR-Falle | `apps/bot/.env`s `DATA_DIR` muss auf ein vom discordbot-User beschreibbares Verzeichnis zeigen (funktionierend: `/tmp/voice-sessions`). `.env.example`s Platzhalter `/opt/discord-recorder/data` ist eine ALTE, root-owned Deployment-Leiche — schon einmal aus Versehen beim "mit example vergleichen" drübergeschrieben worden → EACCES beim Session-Start. Nicht verwechseln |
| Route Bot→Tunnel | systemd-Unit `va-tunnel-route.service` auf bot-host (`ip route replace 10.10.0.0/24 via 192.168.20.4`) |
| Web-UI | nur auf `main` (`/transcript`, Basic-Auth greyhawk/greyhawk, configApi.js Live-Settings) — NICHT auf PR-#11-Branch |

## Bekannte Fallstricke (haben in dieser Session real Zeit gekostet)

1. **CRLF**: Windows-Checkout hat CRLF. Dateien NIE per scp vom Windows-Host auf Linux kopieren → `env: 'bash\r'`. Stattdessen `git show HEAD:pfad | ssh host "cat > ziel"` oder auf dem Ziel `git pull`.
2. **Executable-Bits**: Neue Skripte auf Windows landen als 100644 im Index → `git update-index --chmod=+x <file>` vor Commit.
3. **Bash-Parser**: Apostroph in `${VAR:?message with ' quote}` bricht das Skript. Keine Apostrophe in Parameter-Expansion-Messages.
4. **Verda-API**: `os_volume` braucht zwingend `name` (String) UND `size`. `is_spot` explizit setzen. Bei `VERDA_ALLOW_SPOT=true` nach `spot_price` ranken (nicht `price_per_hour`). 503 `service_unavailable` = Kapazität, retrybar; alles andere sofort abbrechen. Währung der API (usd) ≠ Dashboard (eur) — Preis-Cap ist nicht normalisiert. `POST /v1/scripts` liefert die neue ID als REINEN TEXT zurück (kein JSON!) — nicht bei jedem Endpoint blind JSON annehmen, immer erst den echten Response-Body prüfen (siehe PR #13).
5. **known_hosts**: Jede neue Instanz = neuer Hostkey, IPs werden wiederverwendet → alten Eintrag löschen statt StrictHostKeyChecking zu deaktivieren.
6. **Docker-Volumes root-owned**: Container-User `app` (uid 10001) kann frisch erzeugte named volumes nicht beschreiben — das ist Root Cause hinter allen EACCES-Bugs (siehe Schritt C1).
7. **Discord-Interaction**: `/join` darf NIE auf Server-Start warten (bereits gefixt: Join sofort, `ensureServerReachable` läuft im Hintergrund, Watchdog re-triggert `SERVER_START_CMD` nach 90s Unreachable während aktiver Session).
8. **Neuer Server→Bot-Message-Type = ZWEI Stellen anfassen**: `control.js`s
   `serverCommand`-Allowlist (case-Liste, ~Zeile 361) UND der eigentliche
   Handler-Switch in `transport/index.js`. Ein Type im zweiten, aber nicht im
   ersten registriert → fällt lautlos auf "unknown msg type", der fertige
   Handler wird nie erreicht (genau das ist `transcript_event` passiert,
   siehe PR #16). Bei C2/C3 relevant, falls dort neue Message-Types
   dazukommen (sind aber HTTP-Routen, kein neuer WS-Message-Type nötig).
9. **"Repo public" ≠ "Packages public"**: zwei unabhängige GitHub-Einstellungen.
   Ein PAT-loser `git clone` scheitert an einem privaten Repo, selbst wenn
   die GHCR-Container-Images schon public sind (siehe R4-Historie oben).

---

## Phase A — ERLEDIGT (bzw. durch PR #12 ersetzt)

Schritte 1–4 sind durch: PR #11 gemergt, Version 2.0.0 (`ecafcb3`),
`v2.0.0`-Images published. Schritt 5 (Startup-Script-Regeneration) ist
**ersatzlos entfallen** — PR #12 registriert Scripts dynamisch pro Launch.

## Rollout-Checkliste — Stand 2026-07-10

R1. ✅ **PR #12 gemergt.**
R2. ✅ **bot-host auf main.** Braucht nach #13-#16 nochmal
    `cd ~/discord-voice-assistant && git pull --ff-only && npm ci --omit=dev
    && sudo systemctl restart discord-bot` (oder `./deploy/va bot update`),
    falls das noch nicht passiert ist — sonst laufen dort die #14/#15/#16-Fixes
    nicht. Check: `./deploy/va bot status` zeigt den Commit.
R3. ✅ **`~/.config/va/deploy.env` angelegt und verifiziert** (`env show`,
    `remote up --dry-run` liefen sauber).
R4. ✅ **Repo UND GHCR-Packages public.** (Ursprünglich hier nur "Packages
    public" geplant — das reichte NICHT: der PAT-lose Clone-Pfad im
    Startup-Script braucht ein öffentlich klonbares REPO, nicht nur öffentliche
    Container-Images. Das war eine echte Lücke in diesem Schritt, live
    gefunden. Beides ist jetzt public.)
R5. ✅ **Erster echter Deploy live bestätigt** (2026-07-10): Instanz
    hochgefahren, alle 4 Container healthy, Server loggt `v2.0.0` (Phase-D-2
    damit erledigt), LLM-Antwort + TTS-Wiedergabe funktionierten.
R6. ⏳ **Jetzt actionable** (Bedingung "erfolgreicher R5" ist erfüllt): altes
    Startup-Script im Verda-Dashboard löschen, Branch
    `claude/gpu-cloud-deployment-msrcy3` löschen.
R7. ✅ **Erledigt** (2026-07-10): nginx-Reverse-Proxy auf bot-host installiert
    (`192.168.20.21:7440 → 10.10.0.2:7440`, Config aus deploy/README.md
    „Web UI access", `nginx -t` ok, Service enabled). Web-UI damit LAN-weit
    unter `http://192.168.20.21:7440/transcript/` erreichbar. WEITERHIN
    GÜLTIG: vor jeder Cloudflared-Veröffentlichung `TRANSCRIPT_UI_USER/_PASS`
    ändern (Default greyhawk/greyhawk)!
R8. Teils erledigt: `CONTROL_BEARER` ✅ **rotiert** (2026-07-10, neuer Wert in
    apps/server/.env + apps/bot/.env + deploy.env). Noch offen: ⏳
    `verda-test/soft-love-smashes-fin-01.ppk` lokal auf dem Windows-Rechner
    löschen (privater Key, liegt seit dem Audit noch da), Lizenz-Entscheidung.

## Phase B — Neuer Branch `fix/finalize-cloud-dataflow` von main

**Warum:** `/leave` funktioniert; Live-Transkript-Events (JSONL) streamen seit
PR #16 tatsächlich nach `~/transcripts` auf den Bot-Host (**Achtung:** vor #16
lief die Route nie — der Handler existierte, wurde aber nie erreicht, siehe
Callout oben — verwechsle "Code sieht fertig aus" nicht mit "läuft auch")
und überleben das Instanz-Zerstören. Aber `finalize` ist auf der
Cloud-Instanz **kaputt** (C1: Volume-Rechte — live bestätigt, siehe unten;
C2: kein Upload-Weg), und selbst wenn es liefe, bliebe das Ergebnis
(transcript.md, Audio-Archiv, speaker-map) auf der ephemeren Instanz liegen
und stirbt mit ihr (C3 fehlt). `stop.sh --backup` ist bis dahin der einzige
manuelle Rettungsweg.

**Cloud-Session-tauglich:** komplett (reiner Repo-Code: apps/server,
apps/bot, Dockerfile). Verifikation per `npm test` + Syntax-Checks dort;
die Live-Verifikation (unten) bleibt für User/lokale Session.

### C1. [OPUS] Volume-Ownership-Fix (Root Cause aller EACCES)

- Neu `apps/server/docker-entrypoint.sh` (LF! executable!):
  Start als root → `chown app:app /data` und jedes direkte Kind (NICHT rekursiv,
  Archiv wird GB-groß; campaign ist :ro → `|| true`) → Privilegien droppen via
  `setpriv --reuid=app --regid=app --clear-groups -- "$@"` (util-linux, in
  node:22-slim vorhanden; zur Sicherheit im Build prüfen, Fallback gosu).
- `apps/server/Dockerfile`: `USER app` entfernen, ENTRYPOINT setzen, CMD bleibt
  `["node","src/index.js"]`. WORKDIR-Zeilen nicht anfassen.
- Danach obsolet-prüfen: der TRANSCRIPT_DIR=/data/transcripts-Eintrag in
  deploy/docker-compose.yml bleibt korrekt, funktioniert dann aber wirklich.
- **Live bestätigt (2026-07-10)**, nicht mehr nur Verdacht: Server-Log auf
  der echten Instanz zeigte bei praktisch jedem STT/LLM/TTS-Event
  `[WARN] transcript: log error: EACCES: permission denied, mkdir
  '/data/transcripts'`. Konkreter Akzeptanztest für den Fix: diese Zeile
  darf danach in einer echten Session nicht mehr auftauchen.

### C2. [OPUS] HTTP-Upload statt scp (`FINALIZE_UPLOAD_CMD`)

Server, neu `apps/server/src/finalizeHttp.js`, mounten in `src/index.js` neben
`registerDebugTtsRoute(app)`:
- `PUT /finalize/upload/:sessionId/:filename` — Auth via vorhandenem
  `checkBearer(req, bearer)` aus `src/auth.js` (funktioniert für HTTP-req).
  sessionId muss `/^\d+$/` matchen, filename = basename only (kein `/`, `..`).
  Ziel: `ensureUploadDir(sessionId)` aus `control.js` (Zeile ~134, aktuell
  modul-privat → exportieren). Body STREAMEN: `req.pipe(createWriteStream)`,
  kein express.json/multer (WAVs = mehrere MB; das globale
  `express.json({limit:'32kb'})` greift nur bei Content-Type json, kollidiert nicht).
  Content-Length-Limit ~200MB.
Bot, `apps/bot/src/finalize.js` `uploadSession()`:
- Wenn `FINALIZE_UPLOAD_CMD` gesetzt → alter Pfad UNVERÄNDERT (LAN/Windows-Profil).
- Sonst NEU (statt bisherigem skip): pro Datei in `sourceChunksDir(session)`
  (WAVs + manifest.json) ein PUT via Node-22-fetch:
  `fetch(url, {method:'PUT', headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/octet-stream'}, body: fs.createReadStream(f), duplex:'half'})`
  — `duplex:'half'` ist PFLICHT bei Stream-Body, sonst wirft undici.
- Helper `httpBaseUrl()` in `apps/bot/src/transport/index.js`: SERVER_BASE_URL
  `ws→http`-Normalisierung (Muster: `parseHostPort` in serverAutoStart.js).
- Fehler → throw; `performFinalize()` in index.js behandelt das bereits
  (Status-Revert, WAVs bleiben für Retry) — dort NICHTS ändern.

### C3. [OPUS] Archiv-Auto-Pull zurück auf Bot-Host

- `apps/server/src/finalize/index.js`: Rückgabe um `archiveName: dirName`
  ergänzen (dirName existiert dort schon, Zeile ~146).
- `control.js` `handleFinalize()`: `archiveName` ins `finalize_result` (Zeile ~186).
- `finalizeHttp.js` zusätzlich:
  `GET /finalize/archive/:archiveName/manifest` → `{files:[{relPath,sha256,bytes}]}`
  (Archive-Root-Dateien + `audio/*`; sha256 beim Listen berechnen),
  `GET /finalize/archive/:archiveName/file?path=<relPath>` → Stream.
  archiveName sanitizen wie serverseitig `archiveDirName()` (`[^A-Za-z0-9._-]` raus);
  relPath gegen `..` prüfen und gegen Manifest-Liste validieren.
- Neu `apps/bot/src/archivePuller.js`: `pullArchive({archiveName})` → Manifest
  holen, Dateien laden, je Datei sha256 verifizieren, nach
  `BOT_ARCHIVE_DIR` (Default `~/archive`) schreiben. Konvention identisch zu
  `transcriptWriter.js` (BOT_TRANSCRIPT_DIR `~/transcripts`, Retention-Pattern
  dort abschauen; auch hier `BOT_ARCHIVE_RETENTION_DAYS`, Default 60, tägliches Prune).
- Aufruf in `performFinalize()` (apps/bot/src/index.js) NACH
  `session.finalize = {...}`, VOR applyRetention, in try/catch — Fehler =
  nur Warnzeile im Status, NIE das Finalize-Ergebnis kippen.

### C4. Config-Catalog + Doku (Sonnet)

- Neue Keys in `apps/server/src/configCatalog.js` registrieren (Datei kommt mit
  main-Merge): `BOT_ARCHIVE_DIR`, `BOT_ARCHIVE_RETENTION_DAYS`,
  `BOT_TRANSCRIPT_DIR`, `BOT_TRANSCRIPT_RETENTION_DAYS` (scope bot);
  FINALIZE_UPLOAD_CMD-Beschreibung anpassen („leer = HTTP-Upload, Default").
- `.env.example` beider Apps + `deploy/README.md`: neuen Datenfluss dokumentieren
  (Upload per HTTP, Archiv-Pull automatisch, stop.sh --backup nur noch Notnetz).

## Phase D — Offene, separate Bugs (nicht Teil des Dataflow-Umbaus)

1. **TTS-Playback bricht ab** — vermutlich BEREITS BEHOBEN, aber noch nicht
   formal geschlossen. Ursprüngliche Beobachtung stammte vom ALTEN Bot-Stand
   (v1.6.0/Streaming-Branch vor dem main-Merge): `tts-playback: start` →
   sofort `stopped`, keine Audio-Ausgabe. **Live am 2026-07-10 auf main/v2.0.0
   beobachtet: TTS lief zweimal sauber komplett durch** (`tts-playback: start`
   → alle Frames empfangen/abgespielt → `stream ended` → `player idle`, keine
   vorzeitigen Abbrüche). Kein aktiver Repro mehr nötig, solange das so bleibt
   — nur noch einmal gegenprüfen (z.B. eine Session mit mehreren
   Interrupt/Barge-in-Versuchen), dann diesen Punkt streichen statt mit
   [OPUS]-Aufwand zu suchen.
2. ✅ **Server-Version im Cloud-Image** — erledigt, live bestätigt: Instanz
   loggt korrekt `server v2.0.0 listening on http://0.0.0.0:7440`.
3. **Rabenauge-Kontext**: CAMPAIGN_REMOTE ist leer → Campaign-Volume leer →
   LLM ohne Kampagnen-Kontext. rclone-Setup (README „Campaign data") einrichten,
   wenn gewünscht.

## Verifikations-Matrix (nach Phase B — WO läuft was)

**Cloud-Claude-Code-Session** (kann sie selbst):
1. `npm test` grün (vorher 117/117), `node --check` auf allen geänderten
   JS-Dateien, `bash -n` auf Shell-Dateien.
2. `docker build -f apps/server/Dockerfile .` (falls Docker verfügbar) —
   Entrypoint/USER-Änderung aus C1 baut sauber.
3. Upload-/Manifest-Routen per Unit-Test o. lokalem Server-Start + curl
   (kein GPU nötig: die finalizeHttp-Routen sind reine Datei-/HTTP-Logik).

**User / lokale Session mit LAN-Zugriff (echte Instanz, `--slot test` nehmen!):**
4. `./deploy/va remote up --slot test --ref fix/finalize-cloud-dataflow`, dann
   `docker compose -p va exec server ls -la /data` → alles `app app`.
5. Session aufnehmen, `/finalize run` → Server-Log: PUTs kommen an, keine
   EACCES, `finalize_result ok:true`, 0 missing/mismatched.
6. Bot-Host: `~/archive/<archiveName>/` enthält transcript.md, manifest.json,
   speaker-map.json, audio/* — ohne stop.sh.
7. `~/transcripts/session_*.jsonl` wächst live während der Session
   (Regression-Check fürs Live-Streaming).
8. LAN-Profil-Regression: mit gesetztem FINALIZE_UPLOAD_CMD bleibt Verhalten alt.
9. Aufräumen: `./deploy/va remote down --slot test`.
