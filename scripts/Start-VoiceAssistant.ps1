#Requires -Version 5.1
<#
.SYNOPSIS
    Startet/Stoppt alle lokalen Dienste des Discord Voice Assistant.

.PARAMETER Mode
    server  (Standard) – Whisper + Piper im Hintergrund (hidden, Logs in %TEMP%\va-logs\),
                         Node-Server im aktuellen Fenster. Strg+C beendet alles graceful.
    silent  – Alle Prozesse hidden (Autostart-tauglich). Beenden mit "-Mode stop".
    all     – Windows Terminal mit 3 Panes (Server / Whisper / Piper).
                         Live-Output + Logs (Tee). [X] killt hart, Ctrl+C im Server-Pane graceful.
    stop    – Beendet alle Services (Whisper, Piper, Server). Ollama bleibt laufen.
    check   – Führt check-services.ps1 aus (Health-Status aller Dienste).

.EXAMPLE
    .\scripts\Start-VoiceAssistant.ps1
    .\scripts\Start-VoiceAssistant.ps1 -Mode silent
    .\scripts\Start-VoiceAssistant.ps1 -Mode all
    .\scripts\Start-VoiceAssistant.ps1 -Mode stop
    .\scripts\Start-VoiceAssistant.ps1 -Mode check
#>

param(
    [ValidateSet("server", "silent", "all", "stop", "check")]
    [string]$Mode = "server"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
# Konfiguration
# ============================================================
$WhisperDir    = "C:\Users\nogar\Programme\whisper-vulkan"
$WhisperExe    = "whisper-server.exe"
$WhisperModel  = "models\ggml-medium-q5_0.bin"
$WhisperPort   = 8080

$PiperDir      = "C:\Users\nogar\Programme\piper"
$PiperVenv     = "$PiperDir\piper\Scripts"
$PiperPython   = "$PiperVenv\python.exe"
$PiperPort     = 5000

$OllamaUrl     = "http://localhost:11434"
$OllamaPort    = 11434
$PiperUrl      = "http://localhost:$PiperPort"
$WhisperUrl    = "http://localhost:$WhisperPort"
$ServerPort    = 7440

$RepoRoot      = $PSScriptRoot | Split-Path -Parent
$PiperSvcDir   = "$RepoRoot\services\piper"
$ServerDir     = "$RepoRoot\apps\server"

# ============================================================
# Logs
# ============================================================
$LogDir     = "$env:TEMP\va-logs"
$WhisperLog = "$LogDir\whisper.log"
$PiperLog   = "$LogDir\piper.log"
$ServerLog  = "$LogDir\server.log"
if (-not (Test-Path $LogDir)) { $null = New-Item -ItemType Directory -Path $LogDir -Force }

# Env-Vars für services/piper/server.py (werden an Kindprozesse vererbt)
$env:PIPER_DIR        = $PiperDir
$env:PIPER_EXE        = "$PiperDir\piper.exe"
$env:PIPER_VOICES_DIR = "$PiperDir\voices"

# ============================================================
# Hilfsfunktionen
# ============================================================
function Write-Step { param([string]$Msg) Write-Host ">> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "   OK  $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "   !!  $Msg" -ForegroundColor Yellow }
function Write-Info { param([string]$Msg) Write-Host "   $Msg" -ForegroundColor DarkGray }

function Test-Port {
    param([int]$Port)
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $tcp.Connect("127.0.0.1", $Port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

function Wait-ForPort {
    param([string]$Name, [int]$Port, [int]$TimeoutSec = 90)
    $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
    while ([DateTime]::Now -lt $deadline) {
        if (Test-Port $Port) {
            Write-Ok "$Name antwortet auf Port $Port"
            return $true
        }
        Start-Sleep -Milliseconds 400
    }
    Write-Warn "$Name hat nach $TimeoutSec Sekunden nicht auf Port $Port geantwortet"
    return $false
}

function Wait-ForHttp {
    param([string]$Name, [string]$Url, [int]$TimeoutSec = 90)
    $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
    while ([DateTime]::Now -lt $deadline) {
        try {
            $null = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
            Write-Ok "$Name antwortet auf $Url"
            return $true
        } catch {
            # Whisper antwortet auf / mit 200 oder Method Not Allowed je nach Build → beides ok
            if ($_.Exception.Response.StatusCode.value__ -gt 0) {
                Write-Ok "$Name antwortet auf $Url (HTTP $($_.Exception.Response.StatusCode.value__))"
                return $true
            }
        }
        Start-Sleep -Milliseconds 400
    }
    Write-Warn "$Name hat nach $TimeoutSec Sekunden nicht geantwortet ($Url)"
    return $false
}

# ============================================================
# Service-Stop: erst graceful, dann hart
# ============================================================

# Versucht graceful Shutdown via HTTP-Endpoint (falls implementiert),
# fällt zurück auf taskkill (WM_CLOSE), dann auf Stop-Process (hart).
function Stop-ServiceByPort {
    param(
        [string]$Name,
        [int]$Port,
        [string]$ShutdownUrl = $null,
        [int]$GracefulTimeoutSec = 3,
        [switch]$HardKillOnly
    )

    $procIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    if (-not $procIds) {
        Write-Warn "$Name war bereits gestoppt (kein Prozess auf Port $Port)"
        return
    }

    # Sofort hart killen (kein graceful-Versuch, kein Timeout)
    if ($HardKillOnly) {
        foreach ($p in $procIds) {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
        Write-Ok "$Name beendet"
        return
    }

    # 1. HTTP-Shutdown versuchen (falls Endpoint angegeben)
    $tried = $false
    if ($ShutdownUrl) {
        try {
            $null = Invoke-RestMethod -Uri $ShutdownUrl -Method POST -TimeoutSec 5 -ErrorAction Stop
            $tried = $true
        } catch {
            # Verbindung nach Response geschlossen (Piper/Node schließen sofort nach Antwort):
            # Response-Objekt vorhanden ODER typische Connection-Reset/Timeout-Meldungen
            if ($_.Exception.Response -ne $null -or
                $_.Exception.Message -match 'geschlossen|closed|connection|Zeitlimit|timed out') {
                $tried = $true
            }
        }
    }

    # 2. taskkill ohne /F als Versuch (für GUI/sichtbare Konsolen)
    if (-not $tried) {
        foreach ($p in $procIds) { & taskkill /PID $p 2>&1 | Out-Null }
    }

    # 3. Warten ob's geklappt hat – prüfe Port UND Prozess
    $deadline = [DateTime]::Now.AddSeconds($GracefulTimeoutSec)
    while ([DateTime]::Now -lt $deadline) {
        $portGone    = -not (Test-Port $Port)
        $processGone = -not ($procIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($portGone -or $processGone) {
            Write-Ok "$Name graceful beendet"
            return
        }
        Start-Sleep -Milliseconds 200
    }

    # 4. Hart killen
    foreach ($p in $procIds) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    Write-Warn "$Name hart beendet (graceful Timeout nach ${GracefulTimeoutSec}s)"
}

function Stop-AllServices {
    Write-Step "Beende alle Services..."
    Stop-ServiceByPort -Name "Server (Node)" -Port $ServerPort -ShutdownUrl "http://localhost:$ServerPort/shutdown"
    Stop-ServiceByPort -Name "Piper"         -Port $PiperPort  -ShutdownUrl "$PiperUrl/shutdown"
    Stop-ServiceByPort -Name "Whisper"       -Port $WhisperPort -HardKillOnly
    Write-Ok "Stop abgeschlossen. Logs: $LogDir"
}

# ============================================================
# Service-Start
# ============================================================

function Ensure-Ollama {
    Write-Step "Prüfe Ollama..."
    if (Test-Port $OllamaPort) {
        Write-Ok "Ollama läuft bereits"
        return
    }
    Write-Info "Ollama nicht aktiv, starte 'ollama serve'..."
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
        Write-Warn "ollama.exe nicht im PATH gefunden – bitte manuell starten"
        return
    }
    Start-Process -FilePath ollama -ArgumentList "serve" -WindowStyle Hidden | Out-Null
    if (Wait-ForPort "Ollama" $OllamaPort -TimeoutSec 15) { return }
}

# Löscht alle Service-Logs (frischer Start, kein Anhängen an alte Läufe).
function Clear-AllLogs {
    foreach ($log in @($WhisperLog, $PiperLog, $ServerLog)) {
        try {
            [System.IO.File]::WriteAllText($log, "", [System.Text.Encoding]::UTF8)
        } catch {
            # Datei gesperrt (Prozess läuft noch) – überspringen
        }
    }
}

# Startet einen Service als hidden PS-Prozess.
# stdout UND stderr landen zusammen in einer Log-Datei (kein .err.log).
# Intern läuft ein PowerShell-Wrapper, der 2>&1 | ForEach-Object { "$_" } | Out-File macht.
# Die PID des PS-Wrappers ist irrelevant – Stoppen erfolgt port-basiert.
function Start-ServiceHidden {
    param([string]$Name, [string[]]$ScriptLines, [string]$LogFile)
    $tmpScript = "$env:TEMP\va-hidden-$($Name.ToLower()).ps1"
    $ScriptLines | Set-Content -Path $tmpScript -Encoding UTF8
    Start-Process powershell -ArgumentList @('-NoProfile', '-NoLogo', '-File', $tmpScript) -WindowStyle Hidden
}

function Start-Whisper-Hidden {
    if (Test-Port $WhisperPort) { Write-Warn "Whisper läuft bereits auf Port $WhisperPort"; return }
    Write-Step "Starte Whisper hidden (Log: $WhisperLog)..."
    Start-ServiceHidden -Name "whisper" -LogFile $WhisperLog -ScriptLines @(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
        "Set-Location '$WhisperDir'"
        "& '.\$WhisperExe' --model '$WhisperModel' --port $WhisperPort --language de 2>&1 | ForEach-Object { `"`$_`" } | Out-File -FilePath '$WhisperLog' -Encoding UTF8 -Append"
    )
}

function Start-Piper-Hidden {
    if (Test-Port $PiperPort) { Write-Warn "Piper läuft bereits auf Port $PiperPort"; return }
    Write-Step "Starte Piper hidden (Log: $PiperLog)..."
    Start-ServiceHidden -Name "piper" -LogFile $PiperLog -ScriptLines @(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
        "Set-Location '$PiperSvcDir'"
        "& '$PiperPython' -u -m uvicorn server:app --host 0.0.0.0 --port $PiperPort 2>&1 | ForEach-Object { `"`$_`" } | Out-File -FilePath '$PiperLog' -Encoding UTF8 -Append"
    )
}

function Start-Server-Hidden {
    if (Test-Port $ServerPort) { Write-Warn "Server läuft bereits auf Port $ServerPort"; return }
    Write-Step "Starte Node-Server hidden (Log: $ServerLog)..."
    Start-ServiceHidden -Name "server" -LogFile $ServerLog -ScriptLines @(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
        "Set-Location '$ServerDir'"
        "node src/index.js 2>&1 | ForEach-Object { `"`$_`" } | Out-File -FilePath '$ServerLog' -Encoding UTF8 -Append"
    )
}

# ============================================================
# Modus: check
# ============================================================
if ($Mode -eq "check") {
    $checkScript = Join-Path $PSScriptRoot "check-services.ps1"
    if (Test-Path $checkScript) {
        & $checkScript
    } else {
        Write-Warn "check-services.ps1 nicht gefunden: $checkScript"
        exit 1
    }
    exit
}

# ============================================================
# Modus: stop
# ============================================================
if ($Mode -eq "stop") {
    Stop-AllServices
    exit
}

# ============================================================
# Modus: silent
# ============================================================
if ($Mode -eq "silent") {
    Ensure-Ollama

    if ((Test-Port $WhisperPort) -and (Test-Port $PiperPort) -and (Test-Port $ServerPort)) {
        Write-Ok "Alle Dienste laufen bereits."
        Write-Info "Logs: $LogDir"
        Write-Info "Stoppen mit: .\scripts\Start-VoiceAssistant.ps1 -Mode stop"
        exit
    }

    Clear-AllLogs
    Start-Whisper-Hidden
    Start-Piper-Hidden

    Write-Step "Warte auf Whisper und Piper..."
    $null = Wait-ForHttp "Whisper" "$WhisperUrl/" -TimeoutSec 60
    $null = Wait-ForHttp "Piper"   "$PiperUrl/health"

    Start-Server-Hidden

    Write-Ok "Alle Dienste laufen (silent)."
    Write-Info "Logs: $LogDir"
    Write-Info "Stoppen mit: .\scripts\Start-VoiceAssistant.ps1 -Mode stop"
    exit
}

# ============================================================
# Modus: all – Windows Terminal mit Live-Output + Tee-Logging
# ============================================================
if ($Mode -eq "all") {
    Ensure-Ollama
    Clear-AllLogs

    if (-not (Get-Command wt -ErrorAction SilentlyContinue)) {
        Write-Warn "Windows Terminal nicht gefunden – nutze stattdessen mode 'silent'."
        exit 1
    }

    # Temporäre Pane-Skripte schreiben.
    # Grund: WT zerlegt Inline-Commands an Semikolons (auch wenn diese zur PowerShell-Syntax gehören)
    # → 7 Tabs statt 3 Panes. Pfade als -File-Argument umgehen das Problem komplett.
    # env-Vars (PIPER_DIR etc.) sind bereits im aktuellen Prozess gesetzt und werden vererbt.

    function New-PaneScript {
        param([string]$Name, [string[]]$Lines)
        $path = "$env:TEMP\va-pane-$Name.ps1"
        $Lines | Set-Content -Path $path -Encoding UTF8
        return $path
    }

    $serverPane = New-PaneScript "server" @(
        "Set-Location '$ServerDir'"
        "node src/index.js 2>&1 | ForEach-Object { `"`$_`" } | Tee-Object -FilePath '$ServerLog'"
    )

    $whisperPane = New-PaneScript "whisper" @(
        "Set-Location '$WhisperDir'"
        "& '.\$WhisperExe' --model '$WhisperModel' --port $WhisperPort --language de 2>&1 | ForEach-Object { `"`$_`" } | Tee-Object -FilePath '$WhisperLog'"
    )

    $piperPane = New-PaneScript "piper" @(
        "Set-Location '$PiperSvcDir'"
        "& '$PiperPython' -u -m uvicorn server:app --host 0.0.0.0 --port $PiperPort 2>&1 | ForEach-Object { `"`$_`" } | Tee-Object -FilePath '$PiperLog'"
    )

    Write-Step "Öffne Windows Terminal mit 3 Panes..."

    # WT direkt aufrufen – Array-ArgumentList umgeht PowerShell-Reparsing.
    # Die einzigen ';' sind hier WT-Subcommand-Trenner (eigene Array-Elemente).
    $wtArgs = @(
        'new-tab',     '--title', 'Server',  '--', 'powershell', '-NoProfile', '-File', $serverPane
        ';'
        'split-pane',  '--title', 'Whisper', '--', 'powershell', '-NoProfile', '-File', $whisperPane
        ';'
        'split-pane',  '--title', 'Piper',   '--', 'powershell', '-NoProfile', '-File', $piperPane
    )
    Start-Process -FilePath wt -ArgumentList $wtArgs

    Write-Ok "Windows Terminal gestartet."
    Write-Info "Strg+C im jeweiligen Pane beendet einzelnen Dienst graceful."
    Write-Info "Schließen mit [X] killt hart. Sauber stoppen mit: -Mode stop"
    exit
}

# ============================================================
# Modus: server (Standard)
# Whisper + Piper hidden, Node-Server im foreground.
# ============================================================
Ensure-Ollama

if ((Test-Port $WhisperPort) -and (Test-Port $PiperPort) -and (Test-Port $ServerPort)) {
    Write-Ok "Alle Dienste laufen bereits."
    Write-Info "Logs: $LogDir"
    exit
}

Clear-AllLogs
Start-Whisper-Hidden
Start-Piper-Hidden

Write-Step "Warte auf Whisper und Piper..."
$null = Wait-ForHttp "Whisper" "$WhisperUrl/" -TimeoutSec 60
$null = Wait-ForHttp "Piper"   "$PiperUrl/health"

Write-Step "Starte Node-Server (Port $ServerPort) – Strg+C beendet alle Dienste..."
Write-Info "Logs: $LogDir"
Write-Host ""

try {
    Push-Location $ServerDir
    try {
        # Tee-Object: gleichzeitig auf Konsole ausgeben UND in Log schreiben.
        # ForEach-Object { "$_" } verhindert ErrorRecord-Wrapping für stderr-Zeilen.
        node src/index.js 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $ServerLog
    } finally {
        Pop-Location
    }
} finally {
    Write-Host ""
    Stop-AllServices
}