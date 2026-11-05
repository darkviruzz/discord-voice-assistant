# Bot-Host: Speicherplatz, DATA_DIR und Archiv

Stand 2026-11-05. Anlass: Am 2026-11-04 lief die Platte des Bot-Containers voll
(`discord-bot-jn`, LXC 20021, ZFS-Quota 16G) und das Finalize der Session vom
03.11. scheiterte mit `Unknown system error -122` (= `EDQUOT`). Der Server hatte
das Ergebnis da schon fertig; kaputt waren nur `session.json`, die
`config.overrides.json` und die Finalize-Sperre des Bots. Am 05.11. wurde die
Platte auf 32G vergrößert, und beim Neustart von pve-jn wurde `/tmp` geleert —
dort lag `DATA_DIR`.

## Was der Bot jetzt selbst absichert

- **Atomares Schreiben** von `session.json`, `manifest.json` und
  `config.overrides.json`: Bei voller Platte bleibt die alte Datei intakt statt
  abgeschnitten oder leer.
- **Finalize-Sperre**: wird immer freigegeben; ein Fehler vor dem
  Server-Ergebnis setzt den Status zurück (auch im Speicher). Ist der Server
  fertig, bleibt die Session `finalized` — Archiv-Pull und WAV-Aufräumen
  hängen nur noch Hinweise an.
- **Archiv-Pull** füllt nie die Platte: passt das Archiv nicht neben die
  Reserve (`DISK_RESERVE_MB`), wird er übersprungen; bei „Platte voll“ bricht
  er ab und löscht die angefangene Datei.
- **Klare Meldung** statt `-122`: „💾 Speicher auf dem Bot-Host voll …“.
- **Speicherwarnung** (still, solange Platz ist):
  - bei `/join` eine Zeile, wenn `SESSION_PLAN_HOURS` (5 h) nicht mehr passen,
  - während der Aufnahme je eine Kanal-Meldung bei < 1 h und < 15 min Rest,
  - `/server status` zeigt immer den freien Platz,
  - Warnung beim Start und bei `/join`, solange `DATA_DIR` unter `/tmp` liegt.

## 1. DATA_DIR von /tmp wegziehen (zuerst!)

Debian 12 leert `/tmp` bei jedem Boot (`D /tmp` in tmpfiles.d). Solange
`DATA_DIR=/tmp/voice-sessions` gilt, löscht jeder Neustart des Containers alle
nicht finalisierten Aufnahmen.

Im Container (`pct enter 20021`):

```bash
systemctl stop discord-bot
install -d -o discordbot -g discordbot /home/discordbot/voice-sessions
# Falls /tmp/voice-sessions noch Inhalt hat (gleiches Dateisystem → schnell):
[ -d /tmp/voice-sessions ] && cp -a /tmp/voice-sessions/. /home/discordbot/voice-sessions/
sed -i 's#^DATA_DIR=.*#DATA_DIR=/home/discordbot/voice-sessions#' /home/discordbot/discord-voice-assistant/apps/bot/.env
grep -n DATA_DIR /etc/discord-bot-verda.env   # darf DATA_DIR NICHT setzen (Prozess-Env gewinnt)
systemctl start discord-bot
journalctl -u discord-bot -n 30 --no-pager | grep -i "tmp"   # keine /tmp-Warnung mehr
```

## 2. Archiv der Originale auf dem NAS

Ziel: Die Originale (WAVs, Mix, Transkript) liegen dauerhaft auf dem Pool
`daten` (1,1 TB frei), nicht auf der 32G-Platte des Containers. Der Bot holt
jedes fertige Archiv per sha256 geprüft dorthin; danach braucht er seine
lokalen WAVs nicht mehr.

**Offen, bevor es losgeht:** Wird `daten` gesichert (z. B. auf `backup1`)?
Bind-Mounts sind in vzdump-Backups des Containers nicht enthalten.

Auf pve-jn als root:

```bash
zfs create daten/archiv/rabenauge
zfs get -H -o value mountpoint daten/archiv/rabenauge      # z. B. /daten/archiv/rabenauge
pct config 20021 | grep -E 'unprivileged|^mp'
pct exec 20021 -- id discordbot                            # uid im Container, meist 1000
# Unprivilegierter Container: Host-uid = 100000 + Container-uid
chown 101000:101000 /daten/archiv/rabenauge
pct set 20021 -mp0 /daten/archiv/rabenauge,mp=/mnt/rabenauge-archiv
pct reboot 20021                                            # erst NACH Schritt 1!
```

Im Container, `apps/bot/.env` ergänzen:

```bash
BOT_ARCHIVE_DIR=/mnt/rabenauge-archiv
BOT_ARCHIVE_RETENTION_DAYS=0        # auf dem NAS nie automatisch löschen
ARCHIVE_RETENTION=delete-after-pull # lokale WAVs weg, sobald das NAS-Archiv geprüft ist
ARCHIVED_RETENTION_DAYS=14          # alte _archived/-Reste nach 14 Tagen weg
```

Bestand umziehen:

```bash
systemctl stop discord-bot
# Gezogene Archive (das vom 03.11. ist nur halb da → weglassen, Original liegt auf Windows)
cd /home/discordbot/archive && for d in */; do [ "$d" = "2026-11-03T18-19-50-276Z/" ] && continue; cp -a "$d" /mnt/rabenauge-archiv/; done
# Die drei Sessions von 2025 aus der alten Installation (vermutlich die einzigen Kopien)
install -d -o discordbot -g discordbot /mnt/rabenauge-archiv/2025-discord-recorder
cp -a /opt/discord-recorder/data/. /mnt/rabenauge-archiv/2025-discord-recorder/
du -sh /mnt/rabenauge-archiv/*      # Größen mit dem Original vergleichen
systemctl start discord-bot
```

Erst wenn die Kopien geprüft sind: `/home/discordbot/archive` und
`/opt/discord-recorder` löschen (zusammen ~9,4 GB).

Optional: Das Windows-Server-Archiv (`apps/server/archive`, alle Sessions seit
Mai 2026, ~20 GB) ebenfalls aufs NAS kopieren, dann liegen alle Originale an
einer Stelle.

## 3. Prüfen

- `/server status` in Discord → Zeile `💾 Bot-Speicher: … frei — reicht für ca. … Aufnahme.`
- `/join` → keine Speicher- oder /tmp-Zeile, solange alles passt.
- Nach dem nächsten Finalize: Statusmeldung enthält `📦 Archiv lokal gesichert`
  und `Lokale WAVs gelöscht`; `ls /mnt/rabenauge-archiv` zeigt die Session.

## Einstellungen (auch im Settings-Panel, Gruppe „Bot · Speicherplatz“)

| Key | Default | Bedeutung |
|---|---|---|
| `SESSION_PLAN_HOURS` | 5 | Länge, die bei `/join` passen muss |
| `DISK_MB_PER_HOUR` | 400 | Platzbedarf pro Session-Stunde (gemessen ~370 MB) |
| `DISK_RESERVE_MB` | 300 | bleibt immer frei (Finalize, Archiv-Pull) |
| `DISK_CHECK_INTERVAL_MIN` | 10 | Prüfintervall während der Aufnahme |
| `BOT_ARCHIVE_PULL` | true | Archiv nach Finalize zurückholen |
| `BOT_ARCHIVE_RETENTION_DAYS` | 60 | 0 = nie löschen (NAS) |
| `ARCHIVE_RETENTION` | move | `move` / `delete` / `delete-after-pull` |
| `ARCHIVED_RETENTION_DAYS` | 0 | `_archived/` nach N Tagen löschen, 0 = nie |
