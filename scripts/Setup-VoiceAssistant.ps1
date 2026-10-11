#Requires -Version 5.1
<#
.SYNOPSIS
    Einrichtung und Diagnose des Windows-nativen Voice-Assistant-Servers.

.DESCRIPTION
    Geht Schritt für Schritt alle Bausteine durch (Node, Server-.env, Whisper,
    Piper, Ollama + Embedding-Modell, Obsidian-Vault, Ports, SSH-Autostart), erkennt
    vorhandene Installationen, fragt fehlende Pfade ab, prüft sie und schreibt
    das Ergebnis nach %USERPROFILE%\.config\va\deploy.env (Host-Konfiguration)
    bzw. apps\server\.env (Server-Einstellungen). Vorher wird jeweils eine
    Sicherung *.bak-<zeitstempel> angelegt.

    Start-VoiceAssistant.ps1, check-services.ps1 und deploy\va.ps1 lesen
    dieselbe Konfiguration (scripts\lib\VaLocalConfig.ps1) — keine im Skript
    fest verdrahteten Pfade mehr.

.PARAMETER Check
    Nur prüfen (Doktor-Modus): keine Fragen, keine Änderungen.
    Exit-Code 0 = alles ok, 1 = mindestens ein Fehler.

.PARAMETER Yes
    Nicht-interaktiv: erkannte Werte bzw. Defaults übernehmen und alle
    Ja/Nein-Fragen mit dem Standardwert beantworten (keine Downloads, die
    standardmäßig „nein" sind).

.EXAMPLE
    .\scripts\Setup-VoiceAssistant.ps1
    .\scripts\Setup-VoiceAssistant.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Yes
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest ist mit Fortschrittsbalken ~10x langsamer

$RepoRoot = $PSScriptRoot | Split-Path -Parent
. (Join-Path $PSScriptRoot 'lib\VaLocalConfig.ps1')

$IsWin = ([Environment]::OSVersion.Platform -eq 'Win32NT')
$ServerEnvPath    = Join-Path $RepoRoot 'apps\server\.env'
$ServerEnvExample = Join-Path $RepoRoot 'apps\server\.env.example'
$BearerPlaceholder = 'hier-langes-zufaelliges-secret-eintragen'
$WhisperHfBase = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
$WhisperRecommended = 'ggml-large-v3-turbo-q5_0.bin'
$PiperVoiceBase = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE'
# services\piper\server.py lädt genau diese Dateien (mind. eine muss da sein).
$PiperVoiceFiles = [ordered]@{
    'de_DE-thorsten-high.onnx'             = 'thorsten/high'
    'de_DE-thorsten_emotional-medium.onnx' = 'thorsten_emotional/medium'
}

$VaConfig = Get-VaLocalConfig -RepoRoot $RepoRoot
$Cfg = $VaConfig.Values                       # aktuelle (zusammengeführte) Werte
$HostChanges   = [ordered]@{}                 # → deploy.env
$ServerChanges = [ordered]@{}                 # → apps\server\.env
$Results = New-Object System.Collections.Generic.List[object]

# ============================================================
# Ausgabe / Eingabe
# ============================================================
function Write-Section { param([string]$Title) Write-Host ""; Write-Host "== $Title ==" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Msg) Write-Host "   OK  $Msg" -ForegroundColor Green }
function Write-Warn    { param([string]$Msg) Write-Host "   !!  $Msg" -ForegroundColor Yellow }
function Write-Fail    { param([string]$Msg) Write-Host "   XX  $Msg" -ForegroundColor Red }
function Write-Info    { param([string]$Msg) Write-Host "       $Msg" -ForegroundColor DarkGray }

function Add-Result {
    param([string]$Component, [ValidateSet('OK', 'WARN', 'FAIL', 'SKIP')][string]$Status, [string]$Detail, [string]$Fix = '')
    $Results.Add([pscustomobject]@{ Component = $Component; Status = $Status; Detail = $Detail; Fix = $Fix })
    switch ($Status) {
        'OK'   { Write-Ok $Detail }
        'WARN' { Write-Warn $Detail; if ($Fix) { Write-Info "-> $Fix" } }
        'FAIL' { Write-Fail $Detail; if ($Fix) { Write-Info "-> $Fix" } }
        'SKIP' { Write-Info "(übersprungen) $Detail" }
    }
}

function Read-YesNo {
    param([string]$Question, [bool]$Default = $true)
    if ($Check) { return $false }
    if ($Yes) { return $Default }
    $suffix = if ($Default) { '[J/n]' } else { '[j/N]' }
    while ($true) {
        $a = (Read-Host "   ?   $Question $suffix").Trim().ToLower()
        if ($a -eq '') { return $Default }
        if ($a -in @('j', 'ja', 'y', 'yes')) { return $true }
        if ($a -in @('n', 'nein', 'no')) { return $false }
    }
}

# Wert abfragen: Enter = aktueller Wert, Zahl = Kandidat, '-' = leer (nur
# -Optional), sonst freie Eingabe. $Validate liefert $null (ok) oder Fehlertext.
function Read-Value {
    param(
        [string]$Label,
        [string]$Current,
        [scriptblock]$Validate,
        [string[]]$Candidates = @(),
        [switch]$Optional
    )
    $cands = @($Candidates | Where-Object { $_ } | Select-Object -Unique)
    $currentOk = $Current -and -not (& $Validate $Current)
    if ($Yes) {
        if ($currentOk) { return $Current }
        foreach ($c in $cands) { if (-not (& $Validate $c)) { return $c } }
        return $Current
    }
    while ($true) {
        Write-Host "   ?   $Label" -ForegroundColor White
        if ($Current) {
            $mark = if ($currentOk) { 'ok' } else { 'UNGÜLTIG' }
            Write-Info "aktuell: $Current ($mark)"
        }
        for ($i = 0; $i -lt $cands.Count; $i++) {
            $mark = if (& $Validate $cands[$i]) { '' } else { ' (gültig)' }
            Write-Info ("[{0}] {1}{2}" -f ($i + 1), $cands[$i], $mark)
        }
        $hint = 'Enter = aktuellen Wert behalten'
        if ($Optional) { $hint += ", '-' = leer lassen" }
        $a = (Read-Host "       Pfad/Wert ($hint)").Trim().Trim('"')
        $value = $null
        if ($a -eq '') { $value = $Current }
        elseif ($a -eq '-' -and $Optional) { return '' }
        elseif ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le $cands.Count) { $value = $cands[[int]$a - 1] }
        else { $value = $a }
        if (-not $value) {
            if ($Optional) { return '' }
            Write-Warn 'Wert erforderlich.'
            continue
        }
        $err = & $Validate $value
        if (-not $err) { return $value }
        Write-Warn $err
    }
}

# Nativen Befehl ausführen, ohne dass stderr unter PS 5.1 als Fehler eskaliert.
function Invoke-Native {
    param([string]$Exe, [string[]]$ArgList = @())
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" }
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($out -join "`n") }
    } catch {
        return [pscustomobject]@{ Code = -1; Output = $_.Exception.Message }
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Test-PortOpen {
    param([int]$Port)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(500) -and $tcp.Connected
        $tcp.Close()
        return $ok
    } catch { return $false }
}

function Save-Download {
    param([string]$Url, [string]$Target)
    $part = "$Target.part"
    try {
        Write-Info "Lade $Url ..."
        Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing -ErrorAction Stop
        Move-Item -LiteralPath $part -Destination $Target -Force
        return $true
    } catch {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        Write-Fail "Download fehlgeschlagen: $($_.Exception.Message)"
        return $false
    }
}

function Set-HostValue {
    param([string]$Key, [string]$Value)
    if ($Cfg[$Key] -ne $Value -or $VaConfig.Sources[$Key] -ne 'deploy.env') { $HostChanges[$Key] = $Value }
    $Cfg[$Key] = $Value
}

function Find-Dirs {
    param([string[]]$Roots, [string]$Filter, [int]$Depth = 3, [switch]$Directory)
    $found = @()
    foreach ($r in $Roots) {
        if (-not $r -or -not (Test-Path -LiteralPath $r)) { continue }
        $items = if ($Directory) {
            Get-ChildItem -LiteralPath $r -Filter $Filter -Directory -Recurse -Depth $Depth -Force -ErrorAction SilentlyContinue
        } else {
            Get-ChildItem -LiteralPath $r -Filter $Filter -File -Recurse -Depth $Depth -Force -ErrorAction SilentlyContinue
        }
        foreach ($i in $items) { $found += $i.FullName }
    }
    return $found
}

$HomeDir = Get-VaHomeDir
$Programs = Join-Path $HomeDir 'Programme'
$ServerEnv = Read-VaEnvFile -Path $ServerEnvPath
# Provider-Wahl des Servers (apps\server\.env + Web-Panel): bestimmt, welche
# lokalen Dienste überhaupt eingerichtet/geprüft werden müssen.
$ServerSettings = Get-VaServerSettings -RepoRoot $RepoRoot
$Prov = Get-VaProviders -ServerSettings $ServerSettings

Write-Host ""
Write-Host "Voice Assistant – Server-Setup" -ForegroundColor Cyan
if ($Check) { Write-Host "(Prüfmodus: keine Fragen, keine Änderungen)" -ForegroundColor DarkGray }
Write-Info "Repo:               $RepoRoot"
Write-Info "Host-Konfiguration: $($VaConfig.DeployEnvPath)"
if (-not $IsWin) { Write-Warn 'Kein Windows erkannt – Prüfungen laufen, Dienste lassen sich hier aber nicht starten.' }

# ============================================================
# 1. Node.js + Abhängigkeiten
# ============================================================
Write-Section '1/8  Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Add-Result 'Node' 'FAIL' 'node nicht im PATH' 'winget install OpenJS.NodeJS.LTS  (danach neues Terminal öffnen)'
} else {
    $nv = (Invoke-Native 'node' @('--version')).Output.Trim()
    $major = 0
    if ($nv -match '^v(\d+)') { $major = [int]$Matches[1] }
    if ($major -ge 22) { Add-Result 'Node' 'OK' "Node $nv" }
    else { Add-Result 'Node' 'FAIL' "Node $nv ist zu alt (>= 22 nötig)" 'winget upgrade OpenJS.NodeJS.LTS' }

    if (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\ws')) {
        Add-Result 'npm' 'OK' 'Abhängigkeiten installiert'
    } elseif (Read-YesNo 'npm-Abhängigkeiten fehlen. Jetzt installieren (npm ci)?' $true) {
        Push-Location $RepoRoot
        $r = Invoke-Native 'npm' @('ci', '--omit=dev', '--no-audit', '--no-fund')
        Pop-Location
        if ($r.Code -eq 0) { Add-Result 'npm' 'OK' 'npm ci erfolgreich' }
        else { Add-Result 'npm' 'FAIL' 'npm ci fehlgeschlagen' "Im Repo-Ordner ausführen: npm ci  ($($r.Output.Split("`n")[-1]))" }
    } else {
        Add-Result 'npm' 'FAIL' 'node_modules fehlt' "cd $RepoRoot; npm ci --omit=dev"
    }
}

# ============================================================
# 2. Server-.env
# ============================================================
Write-Section '2/8  Server-Einstellungen (apps\server\.env)'
if (-not (Test-Path -LiteralPath $ServerEnvPath)) {
    if (Read-YesNo 'apps\server\.env fehlt. Aus .env.example anlegen?' $true) {
        Copy-Item -LiteralPath $ServerEnvExample -Destination $ServerEnvPath
        $ServerEnv = Read-VaEnvFile -Path $ServerEnvPath
        Add-Result 'Server-.env' 'OK' 'aus .env.example angelegt'
    } else {
        Add-Result 'Server-.env' 'FAIL' 'apps\server\.env fehlt' 'Copy-Item apps\server\.env.example apps\server\.env'
    }
} else {
    Add-Result 'Server-.env' 'OK' 'vorhanden'
}

$bearer = ''
if ($ServerEnv.Contains('CONTROL_BEARER')) { $bearer = $ServerEnv['CONTROL_BEARER'] }
if (-not $bearer -or $bearer -eq $BearerPlaceholder) {
    if (Read-YesNo 'CONTROL_BEARER ist nicht gesetzt (Server wäre ohne Auth erreichbar). Zufälliges Secret erzeugen?' $true) {
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $bearer = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        $ServerChanges['CONTROL_BEARER'] = $bearer
        Add-Result 'Auth' 'WARN' 'neues CONTROL_BEARER erzeugt – muss identisch auf dem Bot-Host stehen' "Bot-Host: apps/bot/.env → CONTROL_BEARER=$bearer"
    } else {
        Add-Result 'Auth' 'FAIL' 'CONTROL_BEARER fehlt/Platzhalter' 'In apps\server\.env und apps/bot/.env denselben langen Zufallswert eintragen'
    }
} else {
    Add-Result 'Auth' 'OK' 'CONTROL_BEARER gesetzt'
}
$uiUser = if ($ServerEnv.Contains('TRANSCRIPT_UI_USER')) { $ServerEnv['TRANSCRIPT_UI_USER'] } else { 'greyhawk' }
$uiPass = if ($ServerEnv.Contains('TRANSCRIPT_UI_PASS')) { $ServerEnv['TRANSCRIPT_UI_PASS'] } else { 'greyhawk' }
if ($uiUser -eq 'greyhawk' -and $uiPass -eq 'greyhawk') {
    Add-Result 'Web-UI' 'WARN' 'Transkript-UI nutzt Default-Login greyhawk/greyhawk' 'Vor Veröffentlichung (Cloudflare) TRANSCRIPT_UI_USER/_PASS in apps\server\.env ändern'
}
$archiveFormat = if ($ServerEnv.Contains('ARCHIVE_AUDIO_FORMAT')) { $ServerEnv['ARCHIVE_AUDIO_FORMAT'] } else { 'wav' }
if ($archiveFormat -ne 'wav' -and -not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Add-Result 'ffmpeg' 'WARN' "ARCHIVE_AUDIO_FORMAT=$archiveFormat braucht ffmpeg (nicht gefunden)" 'winget install Gyan.FFmpeg'
}

# ============================================================
# 3. Whisper (whisper.cpp, Vulkan)
# ============================================================
Write-Section '3/8  Whisper (Spracherkennung)'
if ($Prov.WhisperEnabled) {
    $validateWhisperDir = {
        param($d)
        if (-not (Test-Path -LiteralPath $d -PathType Container)) { return "Ordner existiert nicht: $d" }
        $exe = Resolve-VaPath -Path $Cfg['VA_WHISPER_EXE'] -Base $d
        if (-not (Test-Path -LiteralPath $exe)) { return "$($Cfg['VA_WHISPER_EXE']) nicht in $d" }
        return $null
    }
    $whisperCands = @($Cfg['VA_WHISPER_DIR']) + @(Find-Dirs -Roots @($Programs, (Join-Path $HomeDir 'Downloads')) -Filter $Cfg['VA_WHISPER_EXE'] -Depth 3 | ForEach-Object { Split-Path -Parent $_ })
    $cmd = Get-Command $Cfg['VA_WHISPER_EXE'] -ErrorAction SilentlyContinue
    if ($cmd) { $whisperCands += (Split-Path -Parent $cmd.Source) }

    if ($Check) {
        $err = & $validateWhisperDir $Cfg['VA_WHISPER_DIR']
        if ($err) { Add-Result 'Whisper' 'FAIL' $err 'Setup-VoiceAssistant.ps1 ohne -Check ausführen' }
        else { Add-Result 'Whisper' 'OK' "whisper-server: $($Cfg['VA_WHISPER_DIR'])" }
    } else {
        $dir = Read-Value -Label 'Ordner mit whisper-server.exe (whisper.cpp, Vulkan-Build)' -Current $Cfg['VA_WHISPER_DIR'] -Validate $validateWhisperDir -Candidates $whisperCands
        if (& $validateWhisperDir $dir) {
            Add-Result 'Whisper' 'FAIL' "whisper-server nicht gefunden ($dir)" 'Vulkan-Build von https://github.com/ggml-org/whisper.cpp/releases entpacken'
        } else {
            Set-HostValue 'VA_WHISPER_DIR' $dir
            Add-Result 'Whisper' 'OK' "whisper-server: $dir"
        }
    }

    $whisperDir = $Cfg['VA_WHISPER_DIR']
    if (Test-Path -LiteralPath $whisperDir) {
        $models = @(Find-Dirs -Roots @($whisperDir) -Filter 'ggml-*.bin' -Depth 2)
        $validateModel = {
            param($m)
            $abs = Resolve-VaPath -Path $m -Base $whisperDir
            if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { return "Modelldatei fehlt: $abs" }
            return $null
        }
        if (-not $Check) {
            if (-not $models -or ($models | ForEach-Object { Split-Path -Leaf $_ }) -notcontains $WhisperRecommended) {
                Write-Info "Empfehlung: $WhisperRecommended (~550 MB) – deutlich genauer als medium, auf GPU kaum langsamer."
                if (Read-YesNo "$WhisperRecommended jetzt herunterladen?" $false) {
                    $modelsDir = Join-Path $whisperDir 'models'
                    if (-not (Test-Path $modelsDir)) { $null = New-Item -ItemType Directory -Path $modelsDir }
                    if (Save-Download "$WhisperHfBase/$WhisperRecommended" (Join-Path $modelsDir $WhisperRecommended)) {
                        $models += (Join-Path $modelsDir $WhisperRecommended)
                    }
                }
            }
            $cur = Resolve-VaPath -Path $Cfg['VA_WHISPER_MODEL'] -Base $whisperDir
            $m = Read-Value -Label 'Whisper-Modell (ggml-*.bin)' -Current $cur -Validate $validateModel -Candidates $models
            if (-not (& $validateModel $m)) {
                $abs = Resolve-VaPath -Path $m -Base $whisperDir
                # relativ speichern, wenn unterhalb des Whisper-Ordners (überlebt Umzug des Ordners)
                if ($abs.StartsWith($whisperDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    $abs = $abs.Substring($whisperDir.TrimEnd('\').Length + 1)
                }
                Set-HostValue 'VA_WHISPER_MODEL' $abs
            }
        }
        $modelErr = & $validateModel $Cfg['VA_WHISPER_MODEL']
        if ($modelErr) { Add-Result 'Whisper-Modell' 'FAIL' $modelErr "Modell nach $whisperDir\models legen: $WhisperHfBase/$WhisperRecommended" }
        else {
            $leaf = Split-Path -Leaf $Cfg['VA_WHISPER_MODEL']
            if ($leaf -match 'tiny|base|small|medium') {
                Add-Result 'Whisper-Modell' 'WARN' "$leaf (kleines Modell)" "Genauer: $WhisperRecommended"
            } else {
                Add-Result 'Whisper-Modell' 'OK' $leaf
            }
        }
    }
} else {
    Add-Result 'Whisper' 'SKIP' "STT_PROVIDER=$($Prov.Stt) — kein lokaler whisper-server nötig"
}

# ============================================================
# 4. Piper (TTS, DirectML-Fork)
# ============================================================
Write-Section '4/8  Piper (Sprachausgabe)'
if ($Prov.PiperEnabled) {
    $validatePiperPy = {
        param($p)
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return "python.exe nicht gefunden: $p" }
        return $null
    }
    $piperCands = @($Cfg['VA_PIPER_PYTHON']) + @(Find-Dirs -Roots @($Programs) -Filter 'python.exe' -Depth 4 |
        Where-Object { $_ -match 'piper' -and $_ -match '\\(venv|\.venv)\\Scripts\\python\.exe$' })
    if (-not $Check) {
        $py = Read-Value -Label 'python.exe der Piper-venv (DirectML-Fork, darkviruzz/piper1-gpl)' -Current $Cfg['VA_PIPER_PYTHON'] -Validate $validatePiperPy -Candidates $piperCands
        if (-not (& $validatePiperPy $py)) { Set-HostValue 'VA_PIPER_PYTHON' $py }
    }
    $piperPy = $Cfg['VA_PIPER_PYTHON']
    if (& $validatePiperPy $piperPy) {
        Add-Result 'Piper' 'FAIL' "Piper-venv fehlt ($piperPy)" 'Fork-venv anlegen: siehe piper1-gpl docs/WORKFLOW.md, dann pip install -r services\piper\requirements.txt'
    } else {
        $imp = Invoke-Native $piperPy @('-c', 'import fastapi, uvicorn; from piper.voice import PiperVoice')
        if ($imp.Code -ne 0) {
            Add-Result 'Piper' 'FAIL' 'Python-Pakete fehlen in der Piper-venv' "$piperPy -m pip install -r `"$RepoRoot\services\piper\requirements.txt`"  (+ pip install -e <piper-fork>)"
        } else {
            Add-Result 'Piper' 'OK' 'venv + Pakete ok'
            $prov = Invoke-Native $piperPy @('-c', "import onnxruntime as o; print(','.join(o.get_available_providers()))")
            $wantDml = Test-VaTrue $Cfg['PIPER_USE_DIRECTML']
            if ($prov.Output -match 'DmlExecutionProvider') {
                if (-not $wantDml -and (Read-YesNo 'DirectML (GPU) ist verfügbar, aber aus. Einschalten?' $true)) { Set-HostValue 'PIPER_USE_DIRECTML' '1'; $wantDml = $true }
                Add-Result 'Piper-GPU' 'OK' ("DirectML verfügbar" + $(if ($wantDml) { ', aktiv' } else { ', inaktiv' }))
            } elseif ($wantDml) {
                Add-Result 'Piper-GPU' 'WARN' "PIPER_USE_DIRECTML=1, aber onnxruntime meldet kein DirectML ($($prov.Output.Trim()))" "$piperPy -m pip install onnxruntime-directml   (oder PIPER_USE_DIRECTML=0 für CPU)"
            } else {
                Add-Result 'Piper-GPU' 'OK' 'CPU-Modus'
            }
        }
    }

    $validateVoices = {
        param($d)
        if (-not (Test-Path -LiteralPath $d -PathType Container)) { return "Ordner existiert nicht: $d" }
        foreach ($f in $PiperVoiceFiles.Keys) {
            if ((Test-Path -LiteralPath (Join-Path $d $f)) -and (Test-Path -LiteralPath (Join-Path $d "$f.json"))) { return $null }
        }
        return "keine der erwarteten Stimmen ($($PiperVoiceFiles.Keys -join ', ') + .json) in $d"
    }
    $voiceCands = @($Cfg['PIPER_VOICES_DIR']) + @(Find-Dirs -Roots @($Programs) -Filter 'de_DE-thorsten*.onnx' -Depth 4 | ForEach-Object { Split-Path -Parent $_ })
    if (-not $Check) {
        $vd = Read-Value -Label 'Ordner mit den Piper-Stimmen (*.onnx + *.onnx.json)' -Current $Cfg['PIPER_VOICES_DIR'] -Validate { param($d) if (Test-Path -LiteralPath $d -PathType Container) { $null } else { "Ordner existiert nicht: $d" } } -Candidates $voiceCands
        if ($vd -and (& $validateVoices $vd) -and (Test-Path -LiteralPath $vd -PathType Container)) {
            if (Read-YesNo 'Keine passende Stimme gefunden. de_DE-thorsten-high (~110 MB) herunterladen?' $true) {
                $f = 'de_DE-thorsten-high.onnx'
                $null = (Save-Download "$PiperVoiceBase/$($PiperVoiceFiles[$f])/$f" (Join-Path $vd $f)) -and
                        (Save-Download "$PiperVoiceBase/$($PiperVoiceFiles[$f])/$f.json" (Join-Path $vd "$f.json"))
            }
        }
        if ($vd) { Set-HostValue 'PIPER_VOICES_DIR' $vd }
    }
    $voiceErr = & $validateVoices $Cfg['PIPER_VOICES_DIR']
    if ($voiceErr) { Add-Result 'Piper-Stimmen' 'FAIL' $voiceErr "Download: $PiperVoiceBase/thorsten/high/" }
    else { Add-Result 'Piper-Stimmen' 'OK' $Cfg['PIPER_VOICES_DIR'] }
} else {
    Add-Result 'Piper' 'SKIP' "TTS_PROVIDER=$($Prov.Tts) — kein lokales Piper nötig"
}

# ============================================================
# 5. Ollama (LLM)
# ============================================================
Write-Section '5/8  Sprachmodell (Ollama / OpenAI-kompatible Server)'

# OpenAI-kompatible Server (LLM/STT/TTS/Embeddings über *_PROVIDER=openai):
# GET <basis>/models zeigt, ob die URL stimmt und der Server läuft.
$openaiTargets = @()
if ($Prov.Llm -eq 'openai') { $openaiTargets += @{ Name = 'LLM'; Url = (Get-VaSetting $ServerSettings 'LLM_BASE_URL'); Key = (Get-VaSetting $ServerSettings 'LLM_API_KEY') } }
if ($Prov.Stt -eq 'openai') { $openaiTargets += @{ Name = 'STT'; Url = (Get-VaSetting $ServerSettings 'STT_BASE_URL'); Key = (Get-VaSetting $ServerSettings 'STT_API_KEY') } }
if ($Prov.Tts -eq 'openai') { $openaiTargets += @{ Name = 'TTS'; Url = (Get-VaSetting $ServerSettings 'TTS_BASE_URL'); Key = (Get-VaSetting $ServerSettings 'TTS_API_KEY') } }
if ((Get-VaSetting $ServerSettings 'EMBED_PROVIDER').ToLower() -eq 'openai' -and -not (Test-VaRagOff -ServerSettings $ServerSettings)) {
    $openaiTargets += @{ Name = 'Embeddings'; Url = (Get-VaSetting $ServerSettings 'EMBED_BASE_URL'); Key = (Get-VaSetting $ServerSettings 'EMBED_API_KEY') }
}
foreach ($t in $openaiTargets) {
    if (-not $t.Url) { Add-Result "$($t.Name)-Server" 'FAIL' "$($t.Name): Provider openai, aber keine Basis-URL gesetzt" 'In apps\server\.env die *_BASE_URL (inkl. /v1) eintragen'; continue }
    $hdr = @{}
    if ($t.Key) { $hdr['Authorization'] = "Bearer $($t.Key)" }
    try {
        $null = Invoke-RestMethod -Uri "$($t.Url.TrimEnd('/'))/models" -Headers $hdr -TimeoutSec 5 -ErrorAction Stop
        Add-Result "$($t.Name)-Server" 'OK' "$($t.Url) antwortet"
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -gt 0) { Add-Result "$($t.Name)-Server" 'WARN' "$($t.Url)/models → HTTP $code (Server läuft — Pfad/Key prüfen)" 'Basis-URL muss den Versionspfad enthalten (…/v1)' }
        else { Add-Result "$($t.Name)-Server" 'FAIL' "$($t.Url) nicht erreichbar" 'OpenAI-kompatiblen Server (z. B. Lemonade, vLLM) starten bzw. URL prüfen' }
    }
}
if ($Prov.OllamaNeeded) {
    $ollamaPort = Get-VaPortFromUrl $Cfg['OLLAMA_URL'] 11434
    $ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollamaCmd -and -not (Test-PortOpen $ollamaPort)) {
        Add-Result 'Ollama' 'FAIL' 'Ollama nicht installiert' 'winget install Ollama.Ollama'
    } else {
        if (-not (Test-PortOpen $ollamaPort) -and $ollamaCmd -and (Read-YesNo 'Ollama läuft nicht. Jetzt starten?' $true)) {
            Start-Process -FilePath $ollamaCmd.Source -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
            for ($i = 0; $i -lt 30 -and -not (Test-PortOpen $ollamaPort); $i++) { Start-Sleep -Milliseconds 500 }
        }
        if (-not (Test-PortOpen $ollamaPort)) {
            Add-Result 'Ollama' 'WARN' "Ollama antwortet nicht auf Port $ollamaPort (Modelle nicht prüfbar)" 'ollama serve'
        } else {
            $have = @()
            try { $have = @((Invoke-RestMethod -Uri "$($Cfg['OLLAMA_URL'].TrimEnd('/'))/api/tags" -TimeoutSec 5).models | ForEach-Object { $_.name }) } catch { }
            $need = @()
            if ($Prov.Llm -eq 'ollama') {
                $need += $(if ($ServerEnv.Contains('OLLAMA_MODEL') -and $ServerEnv['OLLAMA_MODEL']) { $ServerEnv['OLLAMA_MODEL'] } else { 'llama3.2' })
                if ($ServerEnv.Contains('SUMMARY_MODEL') -and $ServerEnv['SUMMARY_MODEL']) { $need += $ServerEnv['SUMMARY_MODEL'] }
            }
            # Embedding-Modell der Vault-Suche (RAG läuft im Node-Server): EMBED_MODEL
            # aus apps\server\.env bzw. dem Web-Panel, Standard nomic-embed-text.
            # Entfällt bei RAG_ENABLED=false oder EMBED_PROVIDER=openai.
            $needEmbed = Get-VaEmbedModel -ServerSettings (Get-VaServerSettings -RepoRoot $RepoRoot)
            if ($needEmbed) { $need += $needEmbed }
            Add-Result 'Ollama' 'OK' "läuft ($($have.Count) Modelle)"
            foreach ($m in ($need | Select-Object -Unique)) {
                $present = $have | Where-Object { $_ -eq $m -or $_ -eq "$($m):latest" -or $_.StartsWith("$($m):") }
                if ($present) { Add-Result "Modell $m" 'OK' "$m vorhanden"; continue }
                $isEmbed = ($needEmbed -and $m -eq $needEmbed)
                if ($ollamaCmd -and (Read-YesNo "Modell '$m' fehlt$(if ($isEmbed) { ' (Embeddings der Vault-Suche)' }). Jetzt laden (ollama pull)?" $true)) {
                    $r = Invoke-Native $ollamaCmd.Source @('pull', $m)
                    if ($r.Code -eq 0) { Add-Result "Modell $m" 'OK' "$m geladen"; continue }
                }
                $lvl = if ($isEmbed) { 'WARN' } else { 'FAIL' }
                Add-Result "Modell $m" $lvl "$m fehlt in Ollama" "ollama pull $m"
            }
        }
    }
} else {
    Add-Result 'Ollama' 'SKIP' 'LLM und Embeddings laufen über OpenAI-kompatible Server — Ollama nicht nötig'
}

# ============================================================
# 6. Obsidian-Vault (Kampagnen-Kontext + Vault-Suche/RAG)
# ============================================================
Write-Section '6/8  Obsidian-Vault + RAG'
$validateVault = {
    param($d)
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { return "Ordner existiert nicht: $d" }
    $md = Get-ChildItem -LiteralPath $d -Filter '*.md' -File -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $md) { return "keine .md-Dateien in $d – ist das wirklich der Vault?" }
    return $null
}
$vaultRoots = @((Join-Path $HomeDir 'Documents'), (Join-Path $HomeDir 'Obsidian'), (Join-Path $HomeDir 'Desktop'), $HomeDir) +
    @(Get-ChildItem -LiteralPath $HomeDir -Filter 'OneDrive*' -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$vaultCands = @($Cfg['VA_VAULT_PATH']) + @(Find-Dirs -Roots $vaultRoots -Filter '.obsidian' -Depth 3 -Directory | ForEach-Object { Split-Path -Parent $_ } | Select-Object -Unique)
if (-not $Check) {
    Write-Info 'Der Vault liefert Kampagnen-Kontext (CAMPAIGN.md) und ist die Wissensbasis der Vault-Suche (RAG im Node-Server).'
    $vault = Read-Value -Label 'Pfad zum Obsidian-Vault der Kampagne' -Current $Cfg['VA_VAULT_PATH'] -Validate $validateVault -Candidates $vaultCands -Optional
    Set-HostValue 'VA_VAULT_PATH' $vault
    if ($vault) { $ServerChanges['OBSIDIAN_VAULT_PATH'] = $vault }
}
$vault = $Cfg['VA_VAULT_PATH']
if (-not $vault) {
    Add-Result 'Vault' 'WARN' 'kein Vault konfiguriert → kein Kampagnen-Kontext, RAG aus' 'Setup erneut ausführen und Vault-Pfad angeben'
} elseif (& $validateVault $vault) {
    Add-Result 'Vault' 'FAIL' (& $validateVault $vault) 'Vault-Pfad korrigieren (Setup ohne -Check)'
} else {
    Add-Result 'Vault' 'OK' $vault
    $campaignFile = if ($ServerEnv.Contains('CAMPAIGN_CONTEXT_FILE')) { $ServerEnv['CAMPAIGN_CONTEXT_FILE'] } else { 'CAMPAIGN.md' }
    if (-not (Test-Path -LiteralPath (Join-Path $vault $campaignFile))) {
        Add-Result 'CAMPAIGN.md' 'WARN' "$campaignFile fehlt im Vault (Fallback-Kontext leer, solange die Vault-Suche nichts liefert)" 'CAMPAIGN.md aus dem Vault generieren lassen'
    } else {
        Add-Result 'CAMPAIGN.md' 'OK' "$campaignFile vorhanden"
    }
    if ($ServerEnv.Contains('OBSIDIAN_VAULT_PATH') -and $ServerEnv['OBSIDIAN_VAULT_PATH'] -and $ServerEnv['OBSIDIAN_VAULT_PATH'] -ne $vault -and -not $ServerChanges.Contains('OBSIDIAN_VAULT_PATH')) {
        Add-Result 'Vault' 'WARN' "apps\server\.env zeigt auf anderen Vault ($($ServerEnv['OBSIDIAN_VAULT_PATH']))" 'Launcher überstimmt das; zur Konsistenz Setup ohne -Check ausführen'
    }

    # --- Vault-Suche (RAG) ---
    # Kein eigener Dienst und kein Python mehr: der Node-Server indexiert den
    # Vault selbst (Index: apps\server\data\rag) mit dem Embedding-Modell aus
    # Abschnitt 5 und fällt auf CAMPAIGN.md zurück, solange der Index fehlt.
    $serverSettings = Get-VaServerSettings -RepoRoot $RepoRoot
    $embedModel = Get-VaEmbedModel -ServerSettings $serverSettings
    if (Test-VaRagOff -ServerSettings $serverSettings) {
        Add-Result 'RAG' 'SKIP' 'RAG_ENABLED=false → nur CAMPAIGN.md'
    } elseif ($embedModel) {
        Add-Result 'RAG' 'OK' "Vault-Suche im Server aktiv (Embeddings: Ollama/$embedModel)"
    } else {
        Add-Result 'RAG' 'OK' 'Vault-Suche im Server aktiv (Embeddings: EMBED_PROVIDER=openai)'
    }
    if (Test-Path -LiteralPath (Join-Path $RepoRoot 'apps\rag')) {
        Write-Info 'apps\rag\ ist ein Überbleibsel des alten Python-RAG-Dienstes (venv + Chroma) und kann gelöscht werden.'
    }
}

# ============================================================
# 7. Ports + SSH-Autostart
# ============================================================
Write-Section '7/8  Ports + Autostart vom Bot'
# Nur Ports lokal laufender Dienste (Provider-Wahl) — externe Server belegen hier nichts.
$ports = [ordered]@{}
if ($Prov.WhisperEnabled) { $ports['Whisper'] = (Get-VaPortFromUrl $Cfg['WHISPER_URL'] 8080) }
if ($Prov.PiperEnabled)   { $ports['Piper'] = (Get-VaPortFromUrl $Cfg['TTS_URL'] 5000) }
$ports['Server'] = [int]$Cfg['VA_SERVER_PORT']
$dupes = $ports.Values | Group-Object | Where-Object { $_.Count -gt 1 }
if ($dupes) { Add-Result 'Ports' 'FAIL' "Port doppelt vergeben: $(($dupes | ForEach-Object { $_.Name }) -join ', ')" 'WHISPER_URL/TTS_URL in deploy.env entzerren' }
$expected = @('whisper-server', 'python', 'pythonw', 'node', 'ollama', 'powershell', 'pwsh')
$conflict = $false
if ($IsWin) {
    foreach ($name in $ports.Keys) {
        $p = $ports[$name]
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $conn) { continue }
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        $pname = if ($proc) { $proc.ProcessName } else { '?' }
        if ($expected -notcontains $pname.ToLower()) {
            $conflict = $true
            Add-Result 'Ports' 'WARN' "Port $p ($name) ist von '$pname' belegt" 'Fremdprozess beenden oder Port in deploy.env ändern'
        }
    }
}
if (-not $dupes -and -not $conflict) { Add-Result 'Ports' 'OK' (($ports.Keys | ForEach-Object { "$_=$($ports[$_])" }) -join '  ') }

if ($IsWin) {
    $sshd = Get-Service -Name sshd -ErrorAction SilentlyContinue
    if (-not $sshd) {
        Add-Result 'SSH' 'WARN' 'OpenSSH-Server nicht installiert → Bot kann den Server nicht automatisch starten' 'Admin-PowerShell: Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0'
    } elseif ($sshd.Status -ne 'Running' -or $sshd.StartType -ne 'Automatic') {
        Add-Result 'SSH' 'WARN' "sshd: $($sshd.Status)/$($sshd.StartType)" 'Admin-PowerShell: Set-Service sshd -StartupType Automatic; Start-Service sshd'
    } else {
        Add-Result 'SSH' 'OK' 'sshd läuft (automatischer Start)'
    }
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = '<ip-dieses-pcs>' }
    Write-Info 'Zeile für apps/bot/.env auf dem Bot-Host (Autostart per SSH):'
    Write-Host ("       SERVER_START_CMD=ssh -i ~/.ssh/id_ed25519_va -o BatchMode=yes -o StrictHostKeyChecking=accept-new {0}@{1} `"powershell -ExecutionPolicy Bypass -File {2}\scripts\Start-VoiceAssistant.ps1 -Mode silent`"" -f $env:USERNAME, $ip, $RepoRoot) -ForegroundColor Gray
}

# ============================================================
# 8. Konfiguration schreiben
# ============================================================
Write-Section '8/8  Konfiguration'
# Server-URLs in apps\server\.env an die Launcher-Ports angleichen — der Launcher
# exportiert sie ohnehin, aber ein manuelles `npm start` soll dasselbe sehen.
if (-not (Test-Path -LiteralPath $ServerEnvPath)) { $ServerChanges.Clear() }   # schon als FAIL gemeldet
else {
    # Nur URLs der lokal genutzten Dienste angleichen (bei *_PROVIDER=openai
    # spricht der Server sie nicht an).
    $localUrls = @()
    if ($Prov.WhisperEnabled) { $localUrls += 'WHISPER_URL' }
    if ($Prov.PiperEnabled)   { $localUrls += 'TTS_URL' }
    if ($Prov.OllamaNeeded)   { $localUrls += 'OLLAMA_URL' }
    foreach ($k in $localUrls) {
        $want = $Cfg[$k].TrimEnd('/')
        if (-not $ServerEnv.Contains($k) -or $ServerEnv[$k].TrimEnd('/') -ne $want) { $ServerChanges[$k] = $want }
    }
}
foreach ($k in @($ServerChanges.Keys)) {
    if ($ServerEnv.Contains($k) -and $ServerEnv[$k] -eq $ServerChanges[$k]) { $ServerChanges.Remove($k) }
}

function Show-Changes {
    param([string]$Title, [System.Collections.IDictionary]$Changes, [System.Collections.IDictionary]$Old)
    if ($Changes.Count -eq 0) { return }
    Write-Host "   $Title" -ForegroundColor White
    foreach ($k in $Changes.Keys) {
        $o = if ($Old.Contains($k)) { $Old[$k] } else { '(neu)' }
        $n = $Changes[$k]
        if ($k -match 'BEARER|SECRET|PASS|TOKEN') { $o = '***'; $n = '***' }
        Write-Info ("{0,-22} {1}  ->  {2}" -f $k, $o, $n)
    }
}

$oldHost = Read-VaEnvFile -Path $VaConfig.DeployEnvPath
if ($HostChanges.Count -eq 0 -and $ServerChanges.Count -eq 0) {
    Write-Ok 'Keine Änderungen nötig.'
} elseif ($Check) {
    Show-Changes "deploy.env ($($VaConfig.DeployEnvPath))" $HostChanges $oldHost
    Show-Changes 'apps\server\.env' $ServerChanges $ServerEnv
    Add-Result 'Konfiguration' 'WARN' 'Abweichungen gefunden (siehe oben)' 'Setup ohne -Check ausführen'
} else {
    Show-Changes "deploy.env ($($VaConfig.DeployEnvPath))" $HostChanges $oldHost
    Show-Changes 'apps\server\.env' $ServerChanges $ServerEnv
    if (Read-YesNo 'Diese Änderungen schreiben (mit Sicherungskopie)?' $true) {
        if ($HostChanges.Count -gt 0) {
            $null = Set-VaEnvFileValues -Path $VaConfig.DeployEnvPath -Values $HostChanges -SectionHeader '# --- windows-native Server (scripts/Setup-VoiceAssistant.ps1) ---'
        }
        if ($ServerChanges.Count -gt 0 -and (Test-Path -LiteralPath $ServerEnvPath)) {
            $null = Set-VaEnvFileValues -Path $ServerEnvPath -Values $ServerChanges
        }
        Add-Result 'Konfiguration' 'OK' 'gespeichert'
    } else {
        Add-Result 'Konfiguration' 'WARN' 'Änderungen verworfen' ''
    }
}

# ============================================================
# Zusammenfassung
# ============================================================
Write-Host ""
Write-Host "== Zusammenfassung ==" -ForegroundColor Cyan
$fails = @($Results | Where-Object { $_.Status -eq 'FAIL' })
$warns = @($Results | Where-Object { $_.Status -eq 'WARN' })
foreach ($r in $Results) {
    $color = switch ($r.Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'DarkGray' } }
    Write-Host ("   {0,-4} {1,-16} {2}" -f $r.Status, $r.Component, $r.Detail) -ForegroundColor $color
}
Write-Host ""
if ($fails.Count -gt 0) {
    Write-Host "   $($fails.Count) Fehler – der Server startet so nicht vollständig. Behebungen:" -ForegroundColor Red
    foreach ($f in $fails) { if ($f.Fix) { Write-Info "$($f.Component): $($f.Fix)" } }
    exit 1
}
if ($warns.Count -gt 0) { Write-Host "   Einsatzbereit mit $($warns.Count) Hinweis(en)." -ForegroundColor Yellow }
else { Write-Host '   Alles bereit.' -ForegroundColor Green }

if (-not $Check -and $IsWin -and (Read-YesNo 'Dienste jetzt starten und Health-Check ausführen?' $true)) {
    & (Join-Path $PSScriptRoot 'Start-VoiceAssistant.ps1') -Mode silent
    & (Join-Path $PSScriptRoot 'check-services.ps1')
}
exit 0
