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
> **Beim Live-Rollout auf dem echten bot-host gefunden + gefixt** (jeweils
> eigener PR, Details dort — hier nur damit spätere Sessions nicht erneut
> stolpern): PR #13 — `POST /v1/scripts` liefert die Script-ID als reinen
> Text statt JSON (cloud-start.sh nahm fälschlich ein JSON-Objekt an) +
> `VERDA_SSH_KEY_ID` fehlte in der `--dry-run`-Redaction. PR #14 — der
> Watchdog in `transport/index.js` gate­te auf `currentSessionId` (bleibt
> über `/leave` hinweg absichtlich gesetzt, für Session-Resume) statt auf
> `hasActiveSession()` (echtes „ist gerade wer in Voice"-Signal) → re-startete
> `SERVER_START_CMD` alle ~5–6 Min unbegrenzt weiter, auch lange nachdem alle
> den Channel verlassen hatten.

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
| CONTROL_BEARER | (secret — liegt in deploy/.env auf der Instanz + apps/bot/.env auf dem Bot; stand bis 2026-07-09 hier im Klartext → **vor Repo-public rotieren**) |
| Verda-Config | Ziel-Zustand: `~/.config/va/deploy.env` auf dem bot-host (Schema in `docs/deploy-architecture.md`); Alt-Bestand `/etc/discord-bot-verda.env` (systemd-EnvironmentFile) gewinnt als Prozess-Env weiterhin über die Datei — beides koexistiert. `VERDA_STARTUP_SCRIPT_ID` ist obsolet (wird ignoriert). OS_IMAGE=`ubuntu-22.04-cuda-12.4-docker` (NIE bare ubuntu-22.04 — kein Docker/CUDA!) |
| Startup-Script | seit PR #12 **dynamisch pro Launch**: `cloud-start.sh` generiert + registriert via `POST /v1/scripts` (`va-<slot>-<slug>-<epoch>`) und räumt alte auf. WG-Privatekey = `VA_WG_KEY_PROD` in deploy.env (Wert stammt aus `/root/boot_private.key`) — NIE rotieren ohne Proxmox-Peer-Update |
| Slots | prod = `va-gpu`/10.10.0.2, test = `va-gpu-test`/10.10.0.3 (eigener Key `VA_WG_KEY_TEST`, Proxmox-Peer einmalig nötig); parallel betreibbar; exakter Hostname-Match überall |
| va-CLI | `deploy/va`: `local up/down/status/logs`, `remote up/down/status/logs/ssh --slot --ref`, `bot update/switch/status/logs`, `env show` (maskiert) |
| Bot-Host-Stand (2026-07-10) | Checkout ist noch `feature/streaming-stt @ 959785a` (v1.6.0!) — hat WEDER transcriptWriter (Live-JSONL-Empfang) NOCH SERVER_STOP_CMD/Watchdog NOCH das neue cloud-start. **Erster Rollout-Schritt = auf main bringen** |
| Route Bot→Tunnel | systemd-Unit `va-tunnel-route.service` auf bot-host (`ip route replace 10.10.0.0/24 via 192.168.20.4`) |
| Web-UI | nur auf `main` (`/transcript`, Basic-Auth greyhawk/greyhawk, configApi.js Live-Settings) — NICHT auf PR-#11-Branch |

## Bekannte Fallstricke (haben in dieser Session real Zeit gekostet)

1. **CRLF**: Windows-Checkout hat CRLF. Dateien NIE per scp vom Windows-Host auf Linux kopieren → `env: 'bash\r'`. Stattdessen `git show HEAD:pfad | ssh host "cat > ziel"` oder auf dem Ziel `git pull`.
2. **Executable-Bits**: Neue Skripte auf Windows landen als 100644 im Index → `git update-index --chmod=+x <file>` vor Commit.
3. **Bash-Parser**: Apostroph in `${VAR:?message with ' quote}` bricht das Skript. Keine Apostrophe in Parameter-Expansion-Messages.
4. **Verda-API**: `os_volume` braucht zwingend `name` (String) UND `size`. `is_spot` explizit setzen. Bei `VERDA_ALLOW_SPOT=true` nach `spot_price` ranken (nicht `price_per_hour`). 503 `service_unavailable` = Kapazität, retrybar; alles andere sofort abbrechen. Währung der API (usd) ≠ Dashboard (eur) — Preis-Cap ist nicht normalisiert.
5. **known_hosts**: Jede neue Instanz = neuer Hostkey, IPs werden wiederverwendet → alten Eintrag löschen statt StrictHostKeyChecking zu deaktivieren.
6. **Docker-Volumes root-owned**: Container-User `app` (uid 10001) kann frisch erzeugte named volumes nicht beschreiben — das ist Root Cause hinter allen EACCES-Bugs (siehe Schritt C1).
7. **Discord-Interaction**: `/join` darf NIE auf Server-Start warten (bereits gefixt: Join sofort, `ensureServerReachable` läuft im Hintergrund, Watchdog re-triggert `SERVER_START_CMD` nach 90s Unreachable während aktiver Session).

---

## Phase A — ERLEDIGT (bzw. durch PR #12 ersetzt)

Schritte 1–4 sind durch: PR #11 gemergt, Version 2.0.0 (`ecafcb3`),
`v2.0.0`-Images published. Schritt 5 (Startup-Script-Regeneration) ist
**ersatzlos entfallen** — PR #12 registriert Scripts dynamisch pro Launch.

## Rollout-Checkliste (User, nach Merge von PR #12 — Reihenfolge einhalten!)

R1. **PR #12 mergen** (`feat/unified-deploy`).
R2. **bot-host auf main bringen** (der Checkout ist noch
    `feature/streaming-stt`! Erster Wechsel manuell, danach gibt es `va bot`):
    ```bash
    cd ~/discord-voice-assistant && git fetch origin \
      && git checkout main && git pull --ff-only \
      && npm ci --omit=dev && sudo systemctl restart discord-bot
    ```
R3. **`~/.config/va/deploy.env` anlegen** (einmalig, als root auf bot-host —
    zieht die Werte aus dem Alt-Bestand zusammen, nichts landet im Chat):
    ```bash
    sudo bash -c '
    umask 077; mkdir -p ~discordbot/.config/va
    {
      grep -E "^(VERDA_CLIENT_ID|VERDA_CLIENT_SECRET|VERDA_SSH_KEY_ID|VERDA_LOCATION_PREFIX|VERDA_OS_IMAGE|VERDA_MAX_HOURLY|VERDA_ALLOW_SPOT|VERDA_MIN_VRAM_GB|VERDA_OS_VOLUME_SIZE_GB)=" /etc/discord-bot-verda.env
      echo "VA_WG_KEY_PROD=$(cat /root/boot_private.key)"
      echo "WG_HOME_PUBKEY=qvQpI+2Q8osKihzsBFhos5YgweclBx6Mb4S3NgAc7Ck="
      echo "WG_ENDPOINT=a6x298v3ofbem8xx.myfritz.net:51820"
      grep -E "^CONTROL_BEARER=" ~discordbot/discord-voice-assistant/apps/bot/.env
    } > ~discordbot/.config/va/deploy.env
    chown -R discordbot:discordbot ~discordbot/.config/va
    chmod 600 ~discordbot/.config/va/deploy.env
    '
    ```
    Check danach als discordbot: `./deploy/va env show` (Werte maskiert) und
    `./deploy/va remote up --dry-run` (druckt redactetes Startup-Script).
R4. **GHCR-Packages public** stellen (GitHub → Packages → `va-server`,
    `va-piper`, `va-whisper` → Change visibility). Alternativ (falls privat
    bleiben soll): `GH_USER`/`GH_PAT` (read:packages) in die deploy.env.
R5. **Erster echter Deploy** = einfach `/join` in Discord (Bot ruft
    `SERVER_START_CMD` → neues cloud-start) — oder manuell:
    `./deploy/va remote up` bzw. `--slot test --ref <branch>` für Branch-Tests.
    Dabei Phase-D-Punkt 2 abhaken (Server-Log muss v2.0.0 zeigen).
R6. **Erst NACH erfolgreichem R5**: altes Startup-Script im Verda-Dashboard
    löschen und Branch `claude/gpu-cloud-deployment-msrcy3` löschen. (Vorher
    NICHT — bis zur Migration ist das alte Dashboard-Script der einzige
    funktionierende /join-Pfad, und es klont genau diesen Branch.)
R7. **Web-UI-Reverse-Proxy** (unverändert offen, nur von LAN/bot-host machbar):
    nginx auf bot-host `192.168.20.21:7440 → 10.10.0.2:7440` (Config wörtlich
    in deploy/README.md „Web UI access"; SSE braucht `proxy_buffering off`).
    Vor jeder Cloudflared-Veröffentlichung: `TRANSCRIPT_UI_USER/_PASS` ändern!
R8. **Vor Repo-public** (unabhängig vom Rest): `CONTROL_BEARER` rotieren
    (`openssl rand -hex 32`; eintragen in apps/bot/.env + deploy.env auf
    bot-host + apps/server/.env auf dem Windows-Rechner — Instanzen bekommen
    ihn ab dann automatisch), `verda-test/soft-love-smashes-fin-01.ppk` lokal
    löschen (privater Key!), Lizenz-Entscheidung.

## Phase B — Neuer Branch `fix/finalize-cloud-dataflow` von main

**Warum:** `/leave` funktioniert; Live-Transkript-Events (JSONL) streamen nach
dem Bot-Update (R2) live nach `~/transcripts` auf den Bot-Host und überleben
das Instanz-Zerstören. Aber `finalize` ist auf der Cloud-Instanz **kaputt**
(C1: Volume-Rechte, C2: kein Upload-Weg), und selbst wenn es liefe, bliebe
das Ergebnis (transcript.md, Audio-Archiv, speaker-map) auf der ephemeren
Instanz liegen und stirbt mit ihr (C3 fehlt). `stop.sh --backup` ist bis
dahin der einzige manuelle Rettungsweg.

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

1. **TTS-Playback bricht ab** [OPUS]: Bot-Log zeigte
   `tts-playback: start` → sofort `stopped`, für BEIDE Requests, obwohl Server
   `debug-tts: done frames=71` meldet. Keine Audio-Ausgabe im Channel. Verdacht:
   Playback/Barge-in-Logik in `apps/bot/src/audio/`-Pfad (FIFO-Playback,
   downlink.js) — reproduzieren mit `/join` + „Hey Rabenauge", dann
   downlink.js/ttsStream-Logs beidseitig vergleichen. ACHTUNG: Beobachtung
   stammt vom ALTEN Bot-Stand (v1.6.0/Streaming-Branch, läuft dort bis R2);
   erst nach R2+R5 auf main reproduzieren — der gemergte Streaming-Rewrite
   kann den Bug verändert/behoben haben. Erst Repro, dann Code anfassen.
2. **Server-Version im Cloud-Image alt**: Log zeigte `server v1.4.1` obwohl
   Branch-Image — nach v2.0.0-Tag verifizieren, dass Instanz `v2.0.0` loggt.
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
