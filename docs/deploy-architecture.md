# Deploy-Architektur: unified local + remote, branch-fähig

Status: v1, 2026-07-09. **Verbindlicher Kontrakt** für CLI, CI und Provisioning —
Änderungen an Var-Namen, Tag-Schema oder CLI-Surface nur hier, dann in den
Implementierungen nachziehen.

## Ziele

- Ein Befehl, zwei Modi: `va local …` (vorhandene Hardware, beliebige GPU) und
  `va remote …` (ephemere Cloud-GPU; Provider austauschbar, heute Verda).
- Jeder Git-Ref deploybar (main, `v*`-Tags, Feature-Branches) — ohne manuelle
  Schritte im Verda-Dashboard.
- Keine Secrets im Repo; Repo public-fähig. Secrets leben pro Host in einer
  Datei **außerhalb des Worktrees** (überlebt Branch-Wechsel — ersetzt die
  bisherigen ad-hoc `va-bot`/`va-server`-Wrapper).
- Claude kann Deploys fahren (lokal + via SSH auf bot-host), ohne Secret-Werte
  je zu sehen: alle dry-runs / `env show` maskieren Werte.

## Begriffe

- **Slot** — feste Identität einer Remote-Instanz:

  | Slot | Hostname | WG-Adresse | WG-Key-Var |
  |---|---|---|---|
  | `prod` | `va-gpu` | `10.10.0.2/24` | `VA_WG_KEY_PROD` |
  | `test` | `va-gpu-test` | `10.10.0.3/24` | `VA_WG_KEY_TEST` |

  Jeder Slot hat einen für immer festen WireGuard-Key → die Peer-Einträge auf
  Proxmox werden genau einmal angelegt und nie wieder angefasst. Prod und Test
  können **parallel** laufen (Feature-Branch testen, während die Runde spielt).
- **Profile** (nur `local`): `cuda` (Linux + NVIDIA, volles Docker-Compose) und
  `windows-native` (aktuelles AMD/Vulkan-Setup: native Prozesse via
  `scripts/Start-VoiceAssistant.ps1`). Künftig denkbar: `rocm-linux`, `cpu`.
- **Ref** — Git-Branch/Tag, der deployt wird: bestimmt sowohl den Clone auf der
  Instanz als auch (per Ableitung) den Image-Tag.

## Image-Tags (CI-Kontrakt)

| Git-Ereignis | Docker-Tags (je Image `va-server`, `va-rag`, `va-piper`, `va-whisper`) |
|---|---|
| push `main` | `latest`, `sha-<shortsha>` |
| push Branch X | `branch-<slug(X)>` |
| tag `vX.Y.Z` | `vX.Y.Z`, `stable` |

**slug()** — Referenz-Implementierung, MUSS in `build-images.yml` und
`cloud-start.sh` identisch sein:

```bash
va_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-40 | sed -E 's/-+$//'
}
```

**Default-Ableitung** `VA_IMAGE_TAG` aus `VA_REF` (überschreibbar per Flag):
`main` → `latest`; `v*` → Ref selbst; sonst → `branch-<slug(REF)>`.

## Env-Layering (Präzedenz: unten gewinnt)

1. `deploy/.env.example` — committete Defaults, keine Secrets (bleibt AUCH die
   Vorlage, aus der das Instanz-Startup-Script `deploy/.env` generiert).
2. `deploy/env/<profile>.env` — committete Profil-Overrides (nur `local`).
3. Secrets/Host-Overrides: Datei `$VA_DEPLOY_ENV`, Default
   `~/.config/va/deploy.env` (chmod 0600; Windows:
   `%USERPROFILE%\.config\va\deploy.env`).
4. Prozess-Env und CLI-Flags (`--ref`, `--image-tag`, `--slot`, `--profile`).

`deploy/.env` ist nur noch ein **generiertes Artefakt** (auf Instanzen vom
Startup-Script, lokal von `va` erzeugt) und bleibt gitignored.

Regel für Scripts: die Deploy-Env-Datei wird gesourct, aber bereits gesetzte
Prozess-Env-Variablen gewinnen (Datei füllt nur Lücken) — so funktioniert
derselbe Aufruf via systemd (Env kommt vom Unit-File) und standalone/SSH
(Env kommt aus der Datei).

**Ausnahme `windows-native`:** Layer 1 entfällt — `deploy/.env.example` trägt
Compose-Hostnamen (`RAG_URL=http://rag:5001`), die native Dienste verbiegen
würden. Die Kette lautet dort: eingebaute Defaults
(`scripts/lib/VaLocalConfig.ps1`) → `deploy/env/windows-native.env` →
`%USERPROFILE%\.config\va\deploy.env` → Prozess-Env (nur für die
Launcher-Keys). Ausgewertet wird sie von `Start-VoiceAssistant.ps1` selbst, damit
der SSH-Autostart des Bots dieselben Werte sieht wie `va.ps1 up`. Host-Pfade
(`VA_WHISPER_DIR`, `VA_WHISPER_MODEL`, `VA_PIPER_PYTHON`, `PIPER_VOICES_DIR`,
`VA_VAULT_PATH`, …) schreibt `scripts/Setup-VoiceAssistant.ps1` (bzw.
`va.ps1 setup`); `va.ps1 doctor` prüft sie ohne Änderungen.

## Secrets-Datei (Schema `~/.config/va/deploy.env`)

```ini
# Verda API (console.verda.com → Keys)
VERDA_CLIENT_ID=…
VERDA_CLIENT_SECRET=…
VERDA_SSH_KEY_ID=…
# WireGuard-Slot-Identitäten — Werte sind FIX, nie rotieren ohne Proxmox-Peer-Update
VA_WG_KEY_PROD=…            # ehem. /root/boot_private.key auf dem bot-host
VA_WG_KEY_TEST=…            # einmalig: wg genkey (Pubkey als 2. Peer auf Proxmox)
WG_HOME_PUBKEY=…
WG_ENDPOINT=example.myfritz.net:51820
# Stack
CONTROL_BEARER=…            # identisch mit apps/bot/.env
# NUR falls Repo/GHCR-Packages privat bleiben (sonst weglassen):
# GH_USER=…
# GH_PAT=…                  # read:packages (+ repo, falls Repo privat)
```

- `VERDA_STARTUP_SCRIPT_ID` **entfällt** — Scripts werden pro Launch via API
  registriert und danach aufgeräumt.
- Backcompat: `WG_PRIVATE_KEY` (alter Name) wird als Fallback für
  `VA_WG_KEY_PROD` akzeptiert.

## CLI-Surface

```
deploy/va   (bash; auf Windows via Git Bash — deploy/va.ps1 für windows-native local)

va local  up|down|status|logs        [--profile cuda|windows-native] [--ref R]
va remote up|down|status|logs|ssh    [--slot prod|test] [--ref R] [--image-tag T] [--dry-run]
va bot    update|switch R|status|logs        # auf dem bot-host ausführen
va env    show [--profile P] [--slot S]      # effektive Env, Secret-Werte maskiert
```

- `va remote up` ist ein dünner Wrapper um `deploy/scripts/cloud-start.sh`
  (keine Logik-Duplikation); `down` → `cloud-stop.sh`.
- `va bot update` = `git pull && npm ci --omit=dev && systemctl restart discord-bot`;
  `va bot switch R` = checkout R + dasselbe (Env liegt außerhalb → überlebt).
- Maskierung: Werte von Variablen, deren Name `_KEY`, `_SECRET`, `_PAT`,
  `_BEARER`, `_TOKEN` oder `PRIVATE` **enthält** (auch mittig — `VA_WG_KEY_PROD`!),
  werden als `«redacted»` ausgegeben. Ausnahme: `…_ID`-Namen wie
  `VERDA_SSH_KEY_ID` sind keine Secrets, bleiben aber der Einfachheit halber
  mit maskiert, wenn sie das Muster treffen — lieber zu viel maskieren.

## Remote-Provisioning (cloud-start.sh, neue Pflichten)

1. Env laden (Layering oben), Slot auflösen (Hostname, WG-Adresse, Key-Var).
2. Startup-Script-Inhalt via `gen-verda-startup.sh` erzeugen — parametrisiert
   mit `VA_REF`, `VA_IMAGE_TAG`, WG-Adresse, `CONTROL_BEARER`. Der
   `docker login`/PAT-Teil wird NUR eingebettet, wenn `GH_PAT` gesetzt ist
   (public Repo/Packages → anonymer Clone + Pull).
3. `POST /v1/scripts` (Name `va-<slot>-<slug>-<epoch>`), zurückgegebene ID für
   die Instanz-Erstellung verwenden; nach erfolgreichem Launch ältere
   `va-<slot>-*`-Scripts löschen (best effort, niemals das gerade benutzte).
4. Idempotenz und `cloud-stop.sh`: **exakter** Hostname-Match des Slots —
   `va-gpu` darf `va-gpu-test` weder als "läuft schon" zählen noch stoppen.
5. `--dry-run` druckt Payload UND generiertes Startup-Script, aber mit
   maskierten Secret-Werten (Regel wie oben).

## Bestand, der sich NICHT ändert

- Instanzseitig: `start.sh`/Compose/`deploy/.env`-Mechanik, Healthchecks,
  WG-Tunnel-Topologie (nur eine zweite feste Peer-Identität für `test` kommt
  auf Proxmox dazu), `va-tunnel-route.service` (Route deckt 10.10.0.0/24 ab).
- Bot-Code: `SERVER_START_CMD`/`SERVER_STOP_CMD` zeigen weiter auf
  `cloud-start.sh`/`cloud-stop.sh` (Default-Slot `prod`).
- Der Windows-native Local-Stack behält sein Verhalten; `va.ps1` wrappt das
  bestehende `Start-VoiceAssistant.ps1` statt es neu zu erfinden. Pfade/Ports
  stehen nicht mehr im Skript, sondern in der Host-Konfiguration
  (`va.ps1 setup` / `va.ps1 doctor`).

## Einmalige Übergangs-Schritte (User, in dieser Reihenfolge)

1. **bot-host**: `~/.config/va/deploy.env` (0600) nach Schema oben anlegen —
   Werte aus `/etc/discord-bot-verda.env` + `sudo cat /root/boot_private.key`
   übernehmen. Danach ist `/etc/discord-bot-verda.env` redundant (Unit-File
   kann die Zeile behalten, bis alles verifiziert ist).
2. **Test-Slot-Peer**: einmalig `wg genkey`/`wg pubkey`, Privatekey als
   `VA_WG_KEY_TEST` in die deploy.env, Pubkey als Peer `10.10.0.3/32` auf
   Proxmox (`wg set wg0 peer <pubkey> allowed-ips 10.10.0.3/32` +
   persistent in wg0.conf).
3. **GHCR-Packages public** stellen (GitHub → Packages → je `va-server`,
   `va-rag`, `va-piper`, `va-whisper` → Change visibility) → PAT entfällt
   komplett. (`va-rag` existiert erst nach dem ersten CI-Lauf mit dem
   RAG-Branch/-Merge — neue GHCR-Packages starten immer privat.)
4. **Vor Repo-public**: `CONTROL_BEARER` rotieren (Wert stand bis 2026-07 im
   Klartext in docs/plans/…), altes Verda-Startup-Script im Dashboard löschen,
   untracked lokale Verzeichnisse (`verda-test/`, `outputs/`, …) prüfen/löschen,
   README-Disclaimer mergen. Optional: Lizenz-Entscheidung.
5. Feature-Branch `claude/gpu-cloud-deployment-msrcy3` löschen (obsolet nach
   diesem Umbau).
