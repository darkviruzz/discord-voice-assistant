#Requires -Version 5.1
<#
.SYNOPSIS
    Startet/Stoppt alle lokalen Dienste des Discord Voice Assistant.

.PARAMETER Mode
    server  (Standard) – Whisper + Piper + RAG im Hintergrund (hidden, Logs in %TEMP%\va-logs\),
                         Node-Server im aktuellen Fenster. Strg+C beendet alles graceful.
    silent  – Alle Prozesse hidden (Autostart-tauglich, so ruft der Bot per SSH auf).
              Beenden mit "-Mode stop".
    all     – Windows Terminal mit 4 Panes (Server / Whisper / Piper / RAG).
                         Live-Output + Logs (Tee). [X] killt hart, Ctrl+C im Server-Pane graceful.
    stop    – Beendet alle Services (Whisper, Piper, RAG, Server). Ollama bleibt laufen.
    check   – Führt check-services.ps1 aus (Health-Status aller Dienste).

.NOTES
    Pfade, Modelle und Ports stehen NICHT mehr in diesem Skript, sondern in
    %USERPROFILE%\.config\va\deploy.env (Layering: scripts\lib\VaLocalConfig.ps1).
    Einrichten/prüfen:  .\scripts\Setup-VoiceAssistant.ps1   bzw.   -Check

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
# Konfiguration (Quelle: scripts\lib\VaLocalConfig.ps1)
# ============================================================
$RepoRoot = $PSScriptRoot | Split-Path -Parent
. (Join-Path $PSScriptRoot 'lib\VaLocalConfig.ps1')

$VaConfig = Get-VaLocalConfig -RepoRoot $RepoRoot
$Svc      = Resolve-VaServices -Config $VaConfig -RepoRoot $RepoRoot

$WhisperDir    = $Svc.WhisperDir
$WhisperExe    = $Svc.WhisperExe
$WhisperModel  = $Svc.WhisperModel
$WhisperLang   = $Svc.WhisperLang
$WhisperPort   = $Svc.WhisperPort
$WhisperUrl    = $Svc.WhisperUrl

$PiperPython   = $Svc.PiperPython
$PiperPort     = $Svc.PiperPort
$PiperUrl      = $Svc.PiperUrl

$OllamaPort    = $Svc.OllamaPort
$ServerPort    = $Svc.ServerPort

$RagPort       = $Svc.RagPort
$RagUrl        = $Svc.RagUrl
$RagPython     = $Svc.RagPython

$PiperSvcDir   = $Svc.PiperSvcDir
$ServerDir     = $Svc.ServerDir
$RagSvcDir     = $Svc.RagSvcDir

# Env für Kindprozesse (Piper/RAG/Node). Gilt für diesen Prozess und wird in
# Hidden-/Pane-Skripte injiziert (die erben die Env nicht).
$ChildEnv = Get-VaChildEnv -Config $VaConfig -Services $Svc
Set-VaProcessEnv -EnvMap $ChildEnv

# ============================================================
# Logs
# ============================================================
$LogDir     = $Svc.LogDir
$WhisperLog = Join-Path $LogDir 'whisper.log'
$PiperLog   = Join-Path $LogDir 'piper.log'
$ServerLog  = Join-Path $LogDir 'server.log'
$RagLog     = Join-Path $LogDir 'rag.log'
if (-not (Test-Path $LogDir)) { $null = New-Item -ItemType Directory -Path $LogDir -Force }

# ============================================================
# Hilfsfunktionen
# ============================================================
function Write-Step { param([string]$Msg) Write-Host ">> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "   OK  $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "   !!  $Msg" -ForegroundColor Yellow }
function Write-Info { param([string]$Msg) Write-Host "   $Msg" -ForegroundColor DarkGray }
function Write-Fail { param([string]$Msg) Write-Host "   XX  $Msg" -ForegroundColor Red }

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

    # Sofort hart killen (kein graceful-Versuch, kein Timeout).
    # Prozesse, die via Scheduled Task (S4U) gestartet wurden, gehören dem
    # aufrufenden User → Stop-Process reicht.  WMI-Terminate als Fallback für
    # eventuell noch vorhandene, via Win32_Process.Create gestartete Prozesse
    # (alter Spawn-Mechanismus) unter einem anderen Account.
    if ($HardKillOnly) {
        foreach ($p in $procIds) {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
            # Fallback: WMI-Terminate falls Prozess noch läuft (fremder Account).
            if (Get-Process -Id $p -ErrorAction SilentlyContinue) {
                $wmiProc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
                if ($wmiProc) {
                    $null = $wmiProc | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue
                }
            }
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

    # 4. Hart killen — gleiche Logik wie HardKillOnly.
    foreach ($p in $procIds) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        if (Get-Process -Id $p -ErrorAction SilentlyContinue) {
            $wmiProc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
            if ($wmiProc) {
                $null = $wmiProc | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue
            }
        }
    }
    Write-Warn "$Name hart beendet (graceful Timeout nach ${GracefulTimeoutSec}s)"
}

function Stop-AllServices {
    Write-Step "Beende alle Services..."
    Stop-ServiceByPort -Name "Server (Node)" -Port $ServerPort -ShutdownUrl "http://localhost:$ServerPort/shutdown"
    Stop-ServiceByPort -Name "Piper"         -Port $PiperPort  -ShutdownUrl "$PiperUrl/shutdown"
    Stop-ServiceByPort -Name "RAG"           -Port $RagPort    -ShutdownUrl "$RagUrl/shutdown"
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
    foreach ($log in @($WhisperLog, $PiperLog, $ServerLog, $RagLog)) {
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
#
# Spawn-Mechanismus: Einmaliger Scheduled Task mit LogonType S4U.
#
# Warum kein Start-Process:
#   Windows-OpenSSH hängt alle Kindprozesse in ein Job-Object mit KILL_ON_JOB_CLOSE.
#   Start-Process-Kinder sterben daher beim SSH-Disconnect.
#
# Warum kein WMI Win32_Process.Create:
#   WMI forkt aus wmiprvse.exe → Prozesse laufen unter dem WMI-Provider-Account
#   (NETWORK SERVICE / SYSTEM), NICHT unter dem aufrufenden User.  Folge: Stop-Process
#   und taskkill /F schlagen ohne Admin-Rechte fehl ("Zugriff verweigert").
#
# Warum Scheduled Task + S4U:
#   - Prozess läuft unter dem Account des aufrufenden Users → Stop-Process funktioniert.
#   - Task Scheduler ist ein eigener Dienst, kein Kind des SSH-Prozesses → überlebt Disconnect.
#   - S4U-Logon: kein gespeichertes Passwort nötig, kein interaktiver Desktop erforderlich.
#   - Task-Definition wird nach dem Spawn sofort wieder gelöscht (Prozess läuft weiter).
#   - Env-Vars werden trotzdem explizit ins Temp-Script re-injected (Task erbt sie nicht).
function Start-ServiceHidden {
    param([string]$Name, [string[]]$ScriptLines, [string]$LogFile)
    $tmpScript = "$env:TEMP\va-hidden-$($Name.ToLower()).ps1"

    # Re-inject env-vars, die der Task-Prozess sonst nicht sieht (Piper-
    # Stimmen, RAG-Vault, Server-URLs — siehe Get-VaChildEnv).
    $envBlock = @(ConvertTo-VaEnvAssignments -EnvMap $ChildEnv)
    ($envBlock + $ScriptLines) | Set-Content -Path $tmpScript -Encoding UTF8

    $taskName    = "VA-Spawn-$($Name.ToLower())"
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

    # Alte Task-Definition aufräumen (z.B. nach Crash).
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    $action    = New-ScheduledTaskAction -Execute "powershell.exe" `
                     -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$tmpScript`""
    # Kein Trigger — Task wird sofort via Start-ScheduledTask gestartet.
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType S4U
    $settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 24) `
                     -MultipleInstances IgnoreNew

    $null = Register-ScheduledTask -TaskName $taskName -Action $action `
                -Principal $principal -Settings $settings -Force -ErrorAction SilentlyContinue

    if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Write-Warn "Scheduled Task für $Name konnte nicht registriert werden – fallback auf Start-Process"
        Start-Process powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', $tmpScript) -WindowStyle Hidden
        return
    }

    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

    # Kurz warten, damit der Prozess spawnt, bevor die Task-Definition gelöscht wird.
    # (Löschen der Definition beendet den laufenden Prozess NICHT.)
    Start-Sleep -Milliseconds 2000

    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

function Start-Whisper-Hidden {
    if (Test-Port $WhisperPort) { Write-Warn "Whisper läuft bereits auf Port $WhisperPort"; return }
    Write-Step "Starte Whisper hidden (Log: $WhisperLog)..."
    Start-ServiceHidden -Name "whisper" -LogFile $WhisperLog -ScriptLines @(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
        "Set-Location '$WhisperDir'"
        "& '$WhisperExe' --model '$WhisperModel' --port $WhisperPort --language $WhisperLang 2>&1 | ForEach-Object { `"`$_`" } | Out-File -FilePath '$WhisperLog' -Encoding UTF8 -Append"
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

function Start-Rag-Hidden {
    if (-not $Svc.RagEnabled) {
        Write-Info "RAG aus (kein Vault oder kein venv konfiguriert) – Server nutzt den CAMPAIGN.md-Fallback."
        return
    }
    if (Test-Port $RagPort) { Write-Warn "RAG läuft bereits auf Port $RagPort"; return }
    Write-Step "Starte RAG hidden (Log: $RagLog)..."
    Start-ServiceHidden -Name "rag" -LogFile $RagLog -ScriptLines @(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
        "Set-Location '$RagSvcDir'"
        "& '$RagPython' -u -m uvicorn server:app --host 0.0.0.0 --port $RagPort 2>&1 | ForEach-Object { `"`$_`" } | Out-File -FilePath '$RagLog' -Encoding UTF8 -Append"
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
# Preflight: Konfiguration prüfen, BEVOR etwas hidden startet — sonst endet
# ein falscher Pfad nur in einem stillen 60-s-Timeout und einer Log-Datei.
# Fehler eines Dienstes, dessen Port schon belegt ist, blockieren nicht
# (der läuft dann offenbar bereits, z. B. manuell gestartet).
# ============================================================
if (-not (Test-Path -LiteralPath $VaConfig.DeployEnvPath)) {
    Write-Warn "Keine Host-Konfiguration ($($VaConfig.DeployEnvPath)) – nutze Defaults."
    Write-Info "Einrichten: .\scripts\Setup-VoiceAssistant.ps1"
}
$portOf = @{ Whisper = $WhisperPort; Piper = $PiperPort; RAG = $RagPort }
$preflight = @(Test-VaServiceConfig -Services $Svc -Config $VaConfig | Where-Object {
    -not ($portOf.ContainsKey($_.Component) -and (Test-Port $portOf[$_.Component]))
})
foreach ($issue in $preflight) {
    if ($issue.Level -eq 'Error') { Write-Fail "$($issue.Component): $($issue.Message)" }
    else { Write-Warn "$($issue.Component): $($issue.Message)" }
}
if (@($preflight | Where-Object { $_.Level -eq 'Error' }).Count -gt 0) {
    Write-Host ""
    Write-Host "Start abgebrochen – Konfiguration unvollständig." -ForegroundColor Red
    Write-Host "Behebung: .\scripts\Setup-VoiceAssistant.ps1   (nur prüfen: -Check)" -ForegroundColor Yellow
    exit 1
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
    Start-Rag-Hidden

    Write-Step "Warte auf Whisper und Piper..."
    $null = Wait-ForHttp "Whisper" "$WhisperUrl/" -TimeoutSec 60
    $null = Wait-ForHttp "Piper"   "$PiperUrl/health"
    # RAG ist optional — kurzer, nicht-blockierender Health-Check.
    $null = Wait-ForHttp "RAG"     "$RagUrl/health" -TimeoutSec 15

    Start-Server-Hidden

    # Health-Check des Node-Servers: "OK" erst wenn /health antwortet.
    # Ohne den Check meldet das Script Erfolg auch wenn Node später crasht.
    $serverOk = Wait-ForHttp "Server" "http://localhost:$ServerPort/health" -TimeoutSec 15

    if ($serverOk) {
        Write-Ok "Alle Dienste laufen (silent)."
    } else {
        Write-Warn "Whisper/Piper laufen, Node-Server hat nicht geantwortet – siehe $ServerLog"
    }
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
    # Env-Block wird jedem Pane-Skript vorangestellt: ein bereits laufendes
    # Windows Terminal öffnet neue Panes aus SEINER Env, nicht aus dieser.

    function New-PaneScript {
        param([string]$Name, [string[]]$Lines)
        $path = "$env:TEMP\va-pane-$Name.ps1"
        (@(ConvertTo-VaEnvAssignments -EnvMap $ChildEnv) + $Lines) | Set-Content -Path $path -Encoding UTF8
        return $path
    }

    $serverPane = New-PaneScript "server" @(
        "Set-Location '$ServerDir'"
        "node src/index.js 2>&1 | ForEach-Object { `"`$_`" } | Tee-Object -FilePath '$ServerLog'"
    )

    $whisperPane = New-PaneScript "whisper" @(
        "Set-Location '$WhisperDir'"
        "& '$WhisperExe' --model '$WhisperModel' --port $WhisperPort --language $WhisperLang 2>&1 | ForEach-Object { `"`$_`" } | Tee-Object -FilePath '$WhisperLog'"
    )

    $piperPane = New-PaneScript "piper" @(
        "Set-Location '$PiperSvcDir'"
        "& '$PiperPython' -u -m uvicorn server:app --host 0.0.0.0 --port $PiperPort 2>&1 | ForEach-Object { `"`$_`" } | Tee-Object -FilePath '$PiperLog'"
    )

    $ragPane = New-PaneScript "rag" @(
        "Set-Location '$RagSvcDir'"
        "& '$RagPython' -u -m uvicorn server:app --host 0.0.0.0 --port $RagPort 2>&1 | ForEach-Object { `"`$_`" } | Tee-Object -FilePath '$RagLog'"
    )

    Write-Step "Öffne Windows Terminal mit 4 Panes..."

    # WT direkt aufrufen – Array-ArgumentList umgeht PowerShell-Reparsing.
    # Die einzigen ';' sind hier WT-Subcommand-Trenner (eigene Array-Elemente).
    $wtArgs = @(
        'new-tab',     '--title', 'Server',  '--', 'powershell', '-NoProfile', '-File', $serverPane
        ';'
        'split-pane',  '--title', 'Whisper', '--', 'powershell', '-NoProfile', '-File', $whisperPane
        ';'
        'split-pane',  '--title', 'Piper',   '--', 'powershell', '-NoProfile', '-File', $piperPane
        ';'
        'split-pane',  '--title', 'RAG',     '--', 'powershell', '-NoProfile', '-File', $ragPane
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
Start-Rag-Hidden

Write-Step "Warte auf Whisper und Piper..."
$null = Wait-ForHttp "Whisper" "$WhisperUrl/" -TimeoutSec 60
$null = Wait-ForHttp "Piper"   "$PiperUrl/health"
# RAG ist optional — kurzer, nicht-blockierender Health-Check.
$null = Wait-ForHttp "RAG"     "$RagUrl/health" -TimeoutSec 15

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