#Requires -Version 5.1
<#
.SYNOPSIS
    Health-Check aller lokalen Voice-Assistant-Dienste.
    Zeigt für jeden Service: Port-Status, HTTP-Health, PID und Detail.
    Die Vault-Suche (RAG) läuft im Node-Server — keine eigene Zeile.
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
# Konfiguration – dieselbe Quelle wie Start-VoiceAssistant.ps1
# ============================================================
$RepoRoot = $PSScriptRoot | Split-Path -Parent
. (Join-Path $PSScriptRoot 'lib\VaLocalConfig.ps1')
$VaConfig = Get-VaLocalConfig -RepoRoot $RepoRoot
$Svc      = Resolve-VaServices -Config $VaConfig -RepoRoot $RepoRoot

# Nur lokale Dienste, die laut Provider-Wahl (apps/server/.env) gebraucht
# werden; die übrigen erscheinen als „extern" (OpenAI-kompatibler Server).
$Services = @()
if ($Svc.WhisperEnabled) { $Services += @{ Name = "Whisper"; Port = $Svc.WhisperPort; HealthUrl = "$($Svc.WhisperUrl)/";        HealthMatch = $null } }
if ($Svc.PiperEnabled)   { $Services += @{ Name = "Piper";   Port = $Svc.PiperPort;   HealthUrl = "$($Svc.PiperUrl)/health";    HealthMatch = "ok"  } }
if ($Svc.OllamaNeeded)   { $Services += @{ Name = "Ollama";  Port = $Svc.OllamaPort;  HealthUrl = "$($Svc.OllamaUrl)/api/tags"; HealthMatch = $null } }
$Services += @{ Name = "Server";  Port = $Svc.ServerPort;  HealthUrl = "http://localhost:$($Svc.ServerPort)/health"; HealthMatch = $null }
$External = @()
if (-not $Svc.WhisperEnabled) { $External += "STT=$($Svc.Providers.Stt)" }
if (-not $Svc.PiperEnabled)   { $External += "TTS=$($Svc.Providers.Tts)" }
if (-not $Svc.OllamaNeeded)   { $External += "LLM=$($Svc.Providers.Llm)" }

$LogDir = $Svc.LogDir

# ============================================================
# Hilfsfunktionen
# ============================================================
function Test-Port {
    param([int]$Port)
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $tcp.Connect("127.0.0.1", $Port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

function Get-PidByPort {
    param([int]$Port)
    $procIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    if ($procIds) { return ($procIds -join ",") }
    return $null
}

function Get-HttpStatus {
    param([string]$Url, [string]$Match)
    try {
        $r = Invoke-RestMethod -Uri $Url -TimeoutSec 3 -ErrorAction Stop
        if ($Match) {
            $json = $r | ConvertTo-Json -Compress -Depth 3 2>$null
            if (-not $json) { $json = "$r" }
            if ($json -match $Match) { return @{ Ok = $true;  Detail = "" } }
            return @{ Ok = $false; Detail = "unerwartete Antwort" }
        }
        return @{ Ok = $true; Detail = "" }
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -gt 0) {
            # Z.B. whisper.cpp gibt auf / oft 405 → Server lebt trotzdem
            return @{ Ok = $true; Detail = "HTTP $code" }
        }
        return @{ Ok = $false; Detail = "HTTP-Fehler" }
    }
}

# ============================================================
# Ausgabe
# ============================================================
Write-Host ""
Write-Host "=== Voice Assistant Service Health ===" -ForegroundColor Cyan
Write-Host ""
Write-Host ("  {0,-9} {1,-7} {2,-12} {3,-8} {4}" -f "Service", "Port", "Status", "PID", "Detail") -ForegroundColor DarkGray
Write-Host ("  {0,-9} {1,-7} {2,-12} {3,-8} {4}" -f "-------", "----", "------", "---", "------") -ForegroundColor DarkGray

$anyDown = $false

foreach ($svc in $Services) {
    $portOpen = Test-Port $svc.Port
    $procId   = if ($portOpen) { Get-PidByPort $svc.Port } else { $null }
    $pidText  = if ($procId) { $procId } else { "-" }

    if (-not $portOpen) {
        $anyDown = $true
        Write-Host ("  {0,-9} {1,-7} " -f $svc.Name, $svc.Port) -NoNewline
        Write-Host ("{0,-12}" -f "DOWN") -ForegroundColor Red -NoNewline
        Write-Host (" {0,-8} {1}" -f $pidText, "Port geschlossen") -ForegroundColor DarkGray
        continue
    }

    if ($svc.HealthUrl) {
        $h = Get-HttpStatus -Url $svc.HealthUrl -Match $svc.HealthMatch
        if ($h.Ok) {
            Write-Host ("  {0,-9} {1,-7} " -f $svc.Name, $svc.Port) -NoNewline
            Write-Host ("{0,-12}" -f "OK") -ForegroundColor Green -NoNewline
            Write-Host (" {0,-8} {1}" -f $pidText, $h.Detail) -ForegroundColor DarkGray
        } else {
            $anyDown = $true
            Write-Host ("  {0,-9} {1,-7} " -f $svc.Name, $svc.Port) -NoNewline
            Write-Host ("{0,-12}" -f "DEGRADED") -ForegroundColor Yellow -NoNewline
            Write-Host (" {0,-8} {1}" -f $pidText, $h.Detail) -ForegroundColor DarkGray
        }
    } else {
        # Server hat keinen Health-Endpoint → reiner Port-Check reicht
        Write-Host ("  {0,-9} {1,-7} " -f $svc.Name, $svc.Port) -NoNewline
        Write-Host ("{0,-12}" -f "OK") -ForegroundColor Green -NoNewline
        Write-Host (" {0,-8} {1}" -f $pidText, "Port offen") -ForegroundColor DarkGray
    }
}

if ($External.Count -gt 0) {
    Write-Host ("  Extern (kein lokaler Dienst): " + ($External -join ', ')) -ForegroundColor DarkGray
}

Write-Host ""
if ($anyDown) {
    Write-Host "  Einige Dienste sind nicht verfügbar." -ForegroundColor Yellow
    if (Test-Path $LogDir) {
        Write-Host "  Logs prüfen: $LogDir" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  Alle Dienste laufen." -ForegroundColor Green
}
Write-Host "  Konfiguration prüfen: .\scripts\Setup-VoiceAssistant.ps1 -Check" -ForegroundColor DarkGray
if ($anyDown) { exit 1 }
Write-Host ""