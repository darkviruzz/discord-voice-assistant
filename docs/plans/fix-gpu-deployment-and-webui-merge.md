# Plan: fix GPU-Deployment dependencies and prepare live transcript web-UI merge

Ausführungsplan für Folge-Sessions (Sonnet/Opus). Kontext: Cloud-GPU-Deployment
(Verda, ephemere Instanzen, WireGuard-Tunnel zu Proxmox) funktioniert end-to-end;
`finalize` ist auf der Cloud-Instanz kaputt (2 Root Causes, unten). Branch
`claude/gpu-cloud-deployment-msrcy3` = PR #11, konfliktfrei gegen `main`.

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
| CONTROL_BEARER | `a453a09f3ef52838f116bd0cb1353162435b5e7808ea064c824a61a1c9e488ae` (deploy/.env auf Instanz + apps/bot/.env auf Bot) |
| Verda-Config | `/etc/discord-bot-verda.env`: CLIENT_ID/SECRET, SSH_KEY_ID, STARTUP_SCRIPT_ID, LOCATION_PREFIX=FIN, OS_IMAGE=`ubuntu-22.04-cuda-12.4-docker` (NIE bare ubuntu-22.04 — kein Docker/CUDA!), MAX_HOURLY, ALLOW_SPOT |
| Startup-Script | registriert bei Verda via `POST /v1/scripts`; generiert von `deploy/scripts/gen-verda-startup.sh`; WG-Privatekey liegt auf bot-host `/root/boot_private.key` — bei Regenerierung WIEDERVERWENDEN, sonst muss Proxmox-Peer geändert werden |
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

## Phase A — Merge & Release v2.0.0 (User führt Merge selbst aus)

1. User merged PR #11 (`gh pr merge 11 --merge`).
2. `git checkout main && git pull`.
3. Version-Bump auf `2.0.0` in GENAU 3 Dateien (Muster = Commit 959785a):
   `apps/bot/package.json`, `apps/server/package.json`, `package-lock.json`
   (dort 2 Stellen: unter `"apps/bot"` und `"apps/server"`).
   Commit: `chore: release 2.0.0 — cloud GPU deployment` + Co-Authored-By-Zeile.
4. `git tag v2.0.0 && git push origin main v2.0.0` → CI (`build-images.yml`,
   Trigger `tags: v*`) published `va-server|va-piper|va-whisper:v2.0.0` nach GHCR.
   Prüfen: `gh run list --limit 3` (dauert ~5 min dank Cache, NICHT 1.5h).
5. Startup-Script regenerieren — auf **bot-host**:
   ```
   cd ~/discord-voice-assistant && git checkout main && git pull
   WG_PRIVATE_KEY="$(sudo cat /root/boot_private.key)" \
   WG_HOME_PUBKEY="qvQpI+2Q8osKihzsBFhos5YgweclBx6Mb4S3NgAc7Ck=" \
   WG_ENDPOINT="a6x298v3ofbem8xx.myfritz.net:51820" \
   GH_USER="darkviruzz" GH_PAT="<aktueller PAT>" \
   CONTROL_BEARER="<siehe Tabelle>" \
   GIT_BRANCH="main" IMAGE_TAG="v2.0.0" \
   ./deploy/scripts/gen-verda-startup.sh > /root/verda-startup-v2.sh
   ```
   Dann via Verda-API neues Script registrieren (`POST /v1/scripts`, Body
   `{name, script}`), neue ID in `/etc/discord-bot-verda.env` als
   `VERDA_STARTUP_SCRIPT_ID` eintragen, altes Script per DELETE aufräumen,
   `/root/verda-startup-v2.sh` löschen. **PAT niemals in Chat/Logs ausgeben.**
6. Erst DANACH Feature-Branch löschen.
7. Web-UI-Erreichbarkeit (schon dokumentiert in deploy/README.md "Web UI access"):
   nginx-Reverse-Proxy auf bot-host 192.168.20.21:7440 → 10.10.0.2:7440 einrichten
   (Config steht wörtlich im README; SSE braucht `proxy_buffering off`).
   Vor jeder späteren Cloudflared-Veröffentlichung: `TRANSCRIPT_UI_USER/_PASS` ändern!

## Phase B — Neuer Branch `fix/finalize-cloud-dataflow` von main

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

1. **TTS-Playback bricht ab** [OPUS]: Bot-Log zeigt
   `tts-playback: start` → sofort `stopped`, für BEIDE Requests, obwohl Server
   `debug-tts: done frames=71` meldet. Keine Audio-Ausgabe im Channel. Verdacht:
   Playback/Barge-in-Logik in `apps/bot/src/audio/`-Pfad (FIFO-Playback,
   downlink.js) — reproduzieren mit `/join` + „Hey Rabenauge", dann
   downlink.js/ttsStream-Logs beidseitig vergleichen. Erst NACH dem main-Merge
   angehen (Streaming-Rewrite von main könnte den Bug schon ändern/beheben).
2. **Server-Version im Cloud-Image alt**: Log zeigte `server v1.4.1` obwohl
   Branch-Image — nach v2.0.0-Tag verifizieren, dass Instanz `v2.0.0` loggt.
3. **Rabenauge-Kontext**: CAMPAIGN_REMOTE ist leer → Campaign-Volume leer →
   LLM ohne Kampagnen-Kontext. rclone-Setup (README „Campaign data") einrichten,
   wenn gewünscht.

## Verifikation (nach Phase B/C, echte Instanz)

1. `docker compose -p va exec server ls -la /data` → alles `app app`.
2. Session aufnehmen, `/finalize run` → Server-Log: PUTs kommen an, keine EACCES,
   `finalize_result ok:true`, 0 missing/mismatched.
3. Bot-Host: `~/archive/<archiveName>/` enthält transcript.md, manifest.json,
   speaker-map.json, audio/* — ohne stop.sh.
4. `~/transcripts/session_*.jsonl` wächst live während der Session (Regression-Check).
5. LAN-Profil-Regression: mit gesetztem FINALIZE_UPLOAD_CMD bleibt Verhalten alt.
