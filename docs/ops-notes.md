# Betriebsnotizen (Bot-Host, Proxmox, Cloud-GPU)

Fakten und Fallstricke aus dem Live-Rollout, die nicht jedes Mal neu
herausgefunden werden sollen. Herausgelöst aus dem archivierten Plan
[`plans/archive/fix-gpu-deployment-and-webui-merge.md`](plans/archive/fix-gpu-deployment-and-webui-merge.md);
der verbindliche Deploy-Kontrakt steht in [`deploy-architecture.md`](deploy-architecture.md).

## Feste Fakten (Stand Juli 2026, live verifiziert)

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

## Bekannte Fallstricke (haben real Zeit gekostet)

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
   siehe PR #16).
9. **"Repo public" ≠ "Packages public"**: zwei unabhängige GitHub-Einstellungen.
   Ein PAT-loser `git clone` scheitert an einem privaten Repo, selbst wenn
   die GHCR-Container-Images schon public sind (siehe R4-Historie oben).

---
