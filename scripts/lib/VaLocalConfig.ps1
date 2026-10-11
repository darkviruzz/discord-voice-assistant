#Requires -Version 5.1
<#
.SYNOPSIS
    Gemeinsame Konfiguration für den Windows-nativen Server-Stack
    (whisper.cpp · Piper · Ollama · RAG · Node-Server).

.DESCRIPTION
    Wird per Dot-Sourcing von Start-VoiceAssistant.ps1, check-services.ps1,
    Setup-VoiceAssistant.ps1 und deploy/va.ps1 geladen, damit ALLE Einstiegs-
    punkte (manuell, va.ps1, va-server.ps1, SSH-Autostart vom Bot) dieselben
    Pfade und Ports sehen.

    Präzedenz (später gewinnt), siehe docs/deploy-architecture.md „Env-Layering":
      1. eingebaute Defaults (unten, Get-VaDefaults)
      2. deploy/env/windows-native.env   (committet, Profil)
      3. %USERPROFILE%\.config\va\deploy.env bzw. $env:VA_DEPLOY_ENV
         (host-spezifisch — schreibt Setup-VoiceAssistant.ps1)
      4. Prozess-Env (nur für die hier bekannten Keys)

    deploy/.env.example wird hier bewusst NICHT gelesen: es ist auf den Docker-
    Stack zugeschnitten (z. B. RAG_URL=http://rag:5001) und würde native
    Dienste auf Container-Hostnamen umbiegen.
#>

# Keys, die der native Launcher besitzt. Nur diese werden aus der Prozess-Env
# übernommen und an Kindprozesse weitergereicht.
$script:VaKnownKeys = @(
    'VA_WHISPER_DIR', 'VA_WHISPER_EXE', 'VA_WHISPER_MODEL', 'WHISPER_LANGUAGE',
    'VA_PIPER_PYTHON', 'PIPER_VOICES_DIR', 'PIPER_USE_DIRECTML', 'PIPER_DIRECTML_DEVICE',
    'VA_VAULT_PATH', 'VA_RAG_ENABLED', 'VA_RAG_PYTHON', 'CHROMA_DIR', 'RAG_EMBED_MODEL',
    'WHISPER_URL', 'TTS_URL', 'OLLAMA_URL', 'RAG_URL', 'VA_SERVER_PORT', 'VA_LOG_DIR'
)

function Get-VaHomeDir {
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    return $HOME
}

function Get-VaDeployEnvPath {
    if ($env:VA_DEPLOY_ENV) { return $env:VA_DEPLOY_ENV }
    return (Join-Path (Join-Path (Get-VaHomeDir) '.config') 'va\deploy.env')
}

function Get-VaTempDir {
    if ($env:TEMP) { return $env:TEMP }
    return [System.IO.Path]::GetTempPath().TrimEnd('\', '/')
}

# KEY=VALUE-Datei lesen (gleiche Regeln wie deploy/scripts/lib-env.sh: keine
# Code-Ausführung, KEY aus [A-Z_][A-Z0-9_]*, eine Ebene Quotes wird entfernt).
function Read-VaEnvFile {
    param([string]$Path)
    $map = [ordered]@{}
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        if ($t.StartsWith('export ')) { $t = $t.Substring(7) }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $t.Substring(0, $eq).Trim()
        if ($key -cnotmatch '^[A-Z_][A-Z0-9_]*$') { continue }
        $val = $t.Substring($eq + 1).Trim()
        if ($val.Length -ge 2 -and
            (($val.StartsWith('"') -and $val.EndsWith('"')) -or
             ($val.StartsWith("'") -and $val.EndsWith("'")))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $map[$key] = $val
    }
    return $map
}

# Keys in einer env-Datei setzen, ohne den Rest anzufassen:
#   - aktive Zeile `KEY=…`  → Wert ersetzt
#   - sonst auskommentierte Vorlage `# KEY=…` → durch aktive Zeile ersetzt
#     (Doku-Kommentar darüber bleibt erhalten)
#   - sonst unten unter $SectionHeader angehängt
# Vorher wird eine Sicherung `<datei>.bak-<zeitstempel>` angelegt. Gibt die
# Liste der tatsächlich geänderten Keys zurück (leer = Datei unverändert).
function Set-VaEnvFileValues {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Values,
        [string]$SectionHeader = '# --- gesetzt von scripts/Setup-VoiceAssistant.ps1 ---',
        [switch]$NoBackup
    )
    $lines = New-Object System.Collections.Generic.List[string]
    # NICHT $newline nennen: PowerShell-Variablen sind case-insensitiv und
    # $newLine (die neue KEY=VALUE-Zeile) unten würde sie überschreiben.
    $eol = "`r`n"
    $exists = Test-Path -LiteralPath $Path
    if ($exists) {
        $raw = [System.IO.File]::ReadAllText($Path)
        if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
        if ($raw -notmatch "`r`n" -and $raw -match "`n") { $eol = "`n" }
        foreach ($l in ($raw -split "`r?`n")) { $lines.Add($l) }
        # split erzeugt nach dem letzten Zeilenumbruch einen leeren Rest
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
    }

    $changed = New-Object System.Collections.Generic.List[string]
    $append = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Values.Keys) {
        $val = [string]$Values[$key]
        $newLine = "$key=$val"
        $activeIdx = -1
        $commentIdx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^\s*(export\s+)?$([regex]::Escape($key))\s*=") { $activeIdx = $i }
            elseif ($commentIdx -lt 0 -and $lines[$i] -match "^\s*#\s*$([regex]::Escape($key))\s*=") { $commentIdx = $i }
        }
        if ($activeIdx -ge 0) {
            $m = [regex]::Match($lines[$activeIdx], '=(.*)$')
            $cur = $m.Groups[1].Value.Trim()
            if ($cur.Length -ge 2 -and (($cur.StartsWith('"') -and $cur.EndsWith('"')) -or ($cur.StartsWith("'") -and $cur.EndsWith("'")))) {
                $cur = $cur.Substring(1, $cur.Length - 2)
            }
            if ($cur -ne $val) { $lines[$activeIdx] = $newLine; $changed.Add($key) }
        } elseif ($commentIdx -ge 0) {
            $lines[$commentIdx] = $newLine
            $changed.Add($key)
        } else {
            $append.Add($newLine)
            $changed.Add($key)
        }
    }
    if ($changed.Count -eq 0) { return @() }

    if ($append.Count -gt 0) {
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -ne '') { $lines.Add('') }
        if (-not ($lines -contains $SectionHeader)) { $lines.Add($SectionHeader) }
        foreach ($a in $append) { $lines.Add($a) }
    }

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    if ($exists -and -not $NoBackup) {
        Copy-Item -LiteralPath $Path -Destination ("$Path.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
    }
    # UTF-8 OHNE BOM: dotenv (Node) und lib-env.sh lesen sonst „﻿KEY".
    $text = ($lines -join $eol) + $eol
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
    return $changed.ToArray()
}

function Get-VaDefaults {
    param([string]$RepoRoot)
    $programs = Join-Path (Get-VaHomeDir) 'Programme'
    return [ordered]@{
        VA_WHISPER_DIR        = (Join-Path $programs 'whisper-vulkan')
        VA_WHISPER_EXE        = 'whisper-server.exe'
        VA_WHISPER_MODEL      = 'models\ggml-medium-q5_0.bin'
        WHISPER_LANGUAGE      = 'de'
        VA_PIPER_PYTHON       = (Join-Path $programs 'piper-directml-fork\venv\Scripts\python.exe')
        PIPER_VOICES_DIR      = (Join-Path $programs 'piper\voices')
        PIPER_USE_DIRECTML    = '1'
        PIPER_DIRECTML_DEVICE = '0'
        VA_VAULT_PATH         = ''
        VA_RAG_ENABLED        = 'auto'
        VA_RAG_PYTHON         = (Join-Path $RepoRoot 'apps\rag\venv\Scripts\python.exe')
        CHROMA_DIR            = (Join-Path $RepoRoot 'apps\rag\chroma')
        RAG_EMBED_MODEL       = 'nomic-embed-text'
        WHISPER_URL           = 'http://localhost:8080'
        TTS_URL               = 'http://localhost:5000'
        OLLAMA_URL            = 'http://localhost:11434'
        RAG_URL               = 'http://localhost:5001'
        VA_SERVER_PORT        = '7440'
        VA_LOG_DIR            = (Join-Path (Get-VaTempDir) 'va-logs')
    }
}

# Zusammengeführte Konfiguration. Rückgabe: @{ Values; Sources; DeployEnvPath; ProfilePath }
function Get-VaLocalConfig {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $values = [ordered]@{}
    $sources = @{}
    $defaults = Get-VaDefaults -RepoRoot $RepoRoot
    foreach ($k in $defaults.Keys) { $values[$k] = $defaults[$k]; $sources[$k] = 'default' }

    # Server-Port: was apps/server/.env als PORT nutzt, ist die Wahrheit für den Node-Server.
    $serverEnv = Read-VaEnvFile -Path (Join-Path $RepoRoot 'apps\server\.env')
    if ($serverEnv.Contains('PORT') -and $serverEnv['PORT']) {
        $values['VA_SERVER_PORT'] = $serverEnv['PORT']; $sources['VA_SERVER_PORT'] = 'apps/server/.env'
    }

    $profilePath = Join-Path $RepoRoot 'deploy\env\windows-native.env'
    $deployEnvPath = Get-VaDeployEnvPath
    foreach ($layer in @(@{ Label = 'profile:windows-native'; Path = $profilePath },
                         @{ Label = 'deploy.env'; Path = $deployEnvPath })) {
        $map = Read-VaEnvFile -Path $layer.Path
        foreach ($k in $map.Keys) {
            if ($script:VaKnownKeys -contains $k) { $values[$k] = $map[$k]; $sources[$k] = $layer.Label }
        }
    }
    foreach ($k in $script:VaKnownKeys) {
        $pv = [Environment]::GetEnvironmentVariable($k)
        if ($null -ne $pv -and $pv -ne '') { $values[$k] = $pv; $sources[$k] = 'process-env' }
    }
    return @{ Values = $values; Sources = $sources; DeployEnvPath = $deployEnvPath; ProfilePath = $profilePath }
}

function Get-VaPortFromUrl {
    param([string]$Url, [int]$Default)
    try {
        $u = [Uri]$Url
        if ($u.Port -gt 0) { return $u.Port }
    } catch { }
    return $Default
}

# Absoluten Pfad bilden: relativ → unter $Base.
function Resolve-VaPath {
    param([string]$Path, [string]$Base)
    if (-not $Path) { return '' }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return (Join-Path $Base $Path)
}

function Test-VaTrue {
    param([string]$Value)
    return ($Value -match '^(1|true|yes|ja|on)$')
}

# Abgeleitete, direkt nutzbare Werte für die Launcher-Skripte.
function Resolve-VaServices {
    param([Parameter(Mandatory)][hashtable]$Config, [Parameter(Mandatory)][string]$RepoRoot)
    $v = $Config.Values
    $whisperDir = $v['VA_WHISPER_DIR']
    $vault = $v['VA_VAULT_PATH']
    $ragPython = $v['VA_RAG_PYTHON']
    $ragMode = ([string]$v['VA_RAG_ENABLED']).ToLower()
    $ragWanted = $false
    if ($ragMode -eq 'auto') {
        $ragWanted = [bool]($vault) -and (Test-Path -LiteralPath $ragPython)
    } else {
        $ragWanted = Test-VaTrue $ragMode
    }
    return [pscustomobject]@{
        RepoRoot       = $RepoRoot
        ServerDir      = (Join-Path $RepoRoot 'apps\server')
        PiperSvcDir    = (Join-Path $RepoRoot 'services\piper')
        RagSvcDir      = (Join-Path $RepoRoot 'apps\rag')
        WhisperDir     = $whisperDir
        WhisperExe     = (Resolve-VaPath -Path $v['VA_WHISPER_EXE'] -Base $whisperDir)
        WhisperModel   = (Resolve-VaPath -Path $v['VA_WHISPER_MODEL'] -Base $whisperDir)
        WhisperLang    = $v['WHISPER_LANGUAGE']
        WhisperUrl     = $v['WHISPER_URL'].TrimEnd('/')
        WhisperPort    = (Get-VaPortFromUrl $v['WHISPER_URL'] 8080)
        PiperPython    = $v['VA_PIPER_PYTHON']
        PiperUrl       = $v['TTS_URL'].TrimEnd('/')
        PiperPort      = (Get-VaPortFromUrl $v['TTS_URL'] 5000)
        OllamaUrl      = $v['OLLAMA_URL'].TrimEnd('/')
        OllamaPort     = (Get-VaPortFromUrl $v['OLLAMA_URL'] 11434)
        RagEnabled     = $ragWanted
        RagPython      = $ragPython
        RagUrl         = $v['RAG_URL'].TrimEnd('/')
        RagPort        = (Get-VaPortFromUrl $v['RAG_URL'] 5001)
        VaultPath      = $vault
        ServerPort     = [int]$v['VA_SERVER_PORT']
        LogDir         = $v['VA_LOG_DIR']
    }
}

# Env-Variablen, die die Kindprozesse brauchen. Gilt für den aktuellen Prozess
# (Node im Vordergrund erbt sie) UND wird in Hidden-/Pane-Skripte injiziert,
# weil Scheduled-Task- bzw. Windows-Terminal-Prozesse die Env NICHT erben.
# Prozess-Env schlägt dotenv: diese Werte überstimmen apps/server/.env —
# genau so sollen Launcher-Ports und Server-URLs nie auseinanderlaufen.
function Get-VaChildEnv {
    param([Parameter(Mandatory)][hashtable]$Config, [Parameter(Mandatory)]$Services)
    $v = $Config.Values
    $envMap = [ordered]@{
        PIPER_VOICES_DIR      = $v['PIPER_VOICES_DIR']
        PIPER_USE_DIRECTML    = $v['PIPER_USE_DIRECTML']
        PIPER_DIRECTML_DEVICE = $v['PIPER_DIRECTML_DEVICE']
        WHISPER_URL           = $Services.WhisperUrl
        TTS_URL               = $Services.PiperUrl
        OLLAMA_URL            = $Services.OllamaUrl
        CHROMA_DIR            = $v['CHROMA_DIR']
        EMBED_MODEL           = $v['RAG_EMBED_MODEL']
        RAG_PORT              = [string]$Services.RagPort
    }
    if ($Services.VaultPath) {
        $envMap['VAULT_PATH'] = $Services.VaultPath           # apps/rag/server.py
        $envMap['OBSIDIAN_VAULT_PATH'] = $Services.VaultPath  # CAMPAIGN.md-Fallback im Server
    }
    # RAG_URL nur exportieren, wenn der Dienst auch gestartet wird — sonst
    # entscheidet weiterhin apps/server/.env (fail-soft auf CAMPAIGN.md).
    if ($Services.RagEnabled) { $envMap['RAG_URL'] = $Services.RagUrl }
    return $envMap
}

function Set-VaProcessEnv {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$EnvMap)
    foreach ($k in $EnvMap.Keys) {
        if ($null -ne $EnvMap[$k] -and [string]$EnvMap[$k] -ne '') {
            [Environment]::SetEnvironmentVariable($k, [string]$EnvMap[$k], 'Process')
        }
    }
}

# PowerShell-Zeilen `$env:KEY = '<wert>'` für generierte Skripte; einfache
# Anführungszeichen im Wert werden verdoppelt (Pfad mit Apostroph bricht sonst).
function ConvertTo-VaEnvAssignments {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$EnvMap)
    $out = @()
    foreach ($k in $EnvMap.Keys) {
        $val = [string]$EnvMap[$k]
        if ($val -eq '') { continue }
        $out += ('$env:' + $k + " = '" + $val.Replace("'", "''") + "'")
    }
    return $out
}

# Probleme der Konfiguration, die einen Start sicher scheitern lassen (Error)
# oder Funktionen abschalten (Warn). Keine Seiteneffekte.
function Test-VaServiceConfig {
    param([Parameter(Mandatory)]$Services, [hashtable]$Config)
    $issues = @()
    $hint = 'scripts\Setup-VoiceAssistant.ps1 ausführen'
    if (-not (Test-Path -LiteralPath $Services.WhisperExe)) {
        $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Whisper'; Message = "whisper-server nicht gefunden: $($Services.WhisperExe)"; Hint = $hint }
    }
    if (-not (Test-Path -LiteralPath $Services.WhisperModel)) {
        $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Whisper'; Message = "Whisper-Modell nicht gefunden: $($Services.WhisperModel)"; Hint = $hint }
    }
    if (-not (Test-Path -LiteralPath $Services.PiperPython)) {
        $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Piper'; Message = "Piper-Python (venv) nicht gefunden: $($Services.PiperPython)"; Hint = $hint }
    }
    if ($Config) {
        $voices = $Config.Values['PIPER_VOICES_DIR']
        if (-not $voices -or -not (Test-Path -LiteralPath $voices)) {
            $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Piper'; Message = "Stimmen-Ordner fehlt: $voices"; Hint = $hint }
        } elseif (-not (Get-ChildItem -LiteralPath $voices -Filter '*.onnx' -File -ErrorAction SilentlyContinue)) {
            $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Piper'; Message = "Keine *.onnx-Stimme in $voices"; Hint = $hint }
        }
    }
    if (-not $Services.VaultPath) {
        $issues += [pscustomobject]@{ Level = 'Warn'; Component = 'RAG'; Message = 'VA_VAULT_PATH nicht gesetzt → RAG und Vault-Kontext aus'; Hint = $hint }
    } elseif (-not (Test-Path -LiteralPath $Services.VaultPath)) {
        $issues += [pscustomobject]@{ Level = 'Warn'; Component = 'RAG'; Message = "Vault-Pfad existiert nicht: $($Services.VaultPath)"; Hint = $hint }
    }
    if ($Services.VaultPath -and -not (Test-Path -LiteralPath $Services.RagPython)) {
        $issues += [pscustomobject]@{ Level = 'Warn'; Component = 'RAG'; Message = "RAG-venv fehlt: $($Services.RagPython) → RAG übersprungen"; Hint = $hint }
    }
    # Elemente einzeln in die Pipeline (Aufrufer klammern mit @(...)).
    return $issues
}
