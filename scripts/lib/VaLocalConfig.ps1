#Requires -Version 5.1
<#
.SYNOPSIS
    Gemeinsame Konfiguration für den Windows-nativen Server-Stack
    (whisper.cpp · Piper · Ollama · Node-Server inkl. Vault-RAG).

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
    Stack zugeschnitten (Compose-Hostnamen, CUDA-/Image-Variablen) und würde
    native Dienste verbiegen.

    Die Vault-Suche (RAG) ist kein eigener Dienst mehr, sondern läuft im Node-
    Server (apps/server/src/rag/). Ihre Einstellungen (RAG_ENABLED, EMBED_MODEL,
    …) stehen deshalb in apps/server/.env bzw. im Web-Panel; der Launcher
    exportiert nur den Vault-Pfad (VA_VAULT_PATH → OBSIDIAN_VAULT_PATH).
#>

# Keys, die der native Launcher besitzt. Nur diese werden aus der Prozess-Env
# übernommen und an Kindprozesse weitergereicht.
$script:VaKnownKeys = @(
    'VA_WHISPER_DIR', 'VA_WHISPER_EXE', 'VA_WHISPER_MODEL', 'WHISPER_LANGUAGE',
    'VA_PIPER_PYTHON', 'PIPER_VOICES_DIR', 'PIPER_USE_DIRECTML', 'PIPER_DIRECTML_DEVICE',
    'VA_VAULT_PATH',
    'WHISPER_URL', 'TTS_URL', 'OLLAMA_URL', 'VA_SERVER_PORT', 'VA_LOG_DIR'
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
        WHISPER_URL           = 'http://localhost:8080'
        TTS_URL               = 'http://localhost:5000'
        OLLAMA_URL            = 'http://localhost:11434'
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

# Einstellungen des Node-Servers, so wie er sie selbst zusammensetzt:
# apps\server\.env, darüber die im Web-Panel gespeicherten Overrides
# (apps\server\data\config.overrides.json, Abschnitt "server"). Nur lesend,
# best effort — eine kaputte Overrides-Datei ignoriert der Server ebenfalls.
function Get-VaServerSettings {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $map = Read-VaEnvFile -Path (Join-Path $RepoRoot 'apps\server\.env')
    $ovPath = Join-Path $RepoRoot 'apps\server\data\config.overrides.json'
    if (Test-Path -LiteralPath $ovPath) {
        try {
            # Get-Content statt [IO.File]: der Provider versteht die '\'-Pfade
            # auch unter pwsh auf Linux (CI-Selbsttest).
            $json = Get-Content -LiteralPath $ovPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            if ($json -and $json.server) {
                foreach ($p in $json.server.PSObject.Properties) { $map[$p.Name] = [string]$p.Value }
            }
        } catch { }
    }
    return $map
}

function Get-VaSetting {
    param([System.Collections.IDictionary]$Map, [string]$Key)
    if ($Map -and $Map.Contains($Key)) { return ([string]$Map[$Key]).Trim() }
    return ''
}

# RAG_ENABLED aus? Dieselben Schreibweisen wie ragEnabled() im Server
# (apps/server/src/rag/index.js); nicht gesetzt = an. (Bewusst ohne
# Mandatory: eine leere Map — noch keine apps\server\.env — ist gültig.)
function Test-VaRagOff {
    param([System.Collections.IDictionary]$ServerSettings)
    return ((Get-VaSetting $ServerSettings 'RAG_ENABLED') -match '^(false|0|off|no)$')
}

# Embedding-Modell, das die Vault-Suche (RAG im Node-Server) in Ollama braucht,
# oder $null, wenn keins nötig ist: RAG abgeschaltet oder Embeddings von einem
# OpenAI-kompatiblen Server (EMBED_PROVIDER=openai). Dieselben Defaults wie
# apps/server/src/providers/embed.js.
function Get-VaEmbedModel {
    param([System.Collections.IDictionary]$ServerSettings)
    if (Test-VaRagOff -ServerSettings $ServerSettings) { return $null }
    if ((Get-VaSetting $ServerSettings 'EMBED_PROVIDER').ToLower() -eq 'openai') { return $null }
    $model = Get-VaSetting $ServerSettings 'EMBED_MODEL'
    if (-not $model) { $model = 'nomic-embed-text' }
    return $model
}

# Welche Modell-Backends der Node-Server laut apps/server/.env (+ Panel-
# Overrides) anspricht — und damit, welche lokalen Dienste der Launcher
# starten/prüfen muss. Dieselben Defaults wie apps/server/src/providers/*.js:
#   STT_PROVIDER   whispercpp (Standard) | openai   → whisper-server nötig?
#   TTS_PROVIDER   piper (Standard) | openai | elevenlabs → Piper nötig?
#   LLM_PROVIDER   ollama (Standard) | openai
#   EMBED_PROVIDER ollama (Standard) | openai (nur relevant, wenn RAG an ist)
# Ollama wird gebraucht, sobald LLM oder Embeddings über Ollama laufen.
function Get-VaProviders {
    param([System.Collections.IDictionary]$ServerSettings)
    $stt = (Get-VaSetting $ServerSettings 'STT_PROVIDER').ToLower()
    if ($stt -ne 'openai') { $stt = 'whispercpp' }
    $tts = (Get-VaSetting $ServerSettings 'TTS_PROVIDER').ToLower()
    if ($tts -notin @('openai', 'elevenlabs')) { $tts = 'piper' }
    $llm = (Get-VaSetting $ServerSettings 'LLM_PROVIDER').ToLower()
    if ($llm -ne 'openai') { $llm = 'ollama' }
    $embedModel = Get-VaEmbedModel -ServerSettings $ServerSettings
    return [pscustomobject]@{
        Stt            = $stt
        Tts            = $tts
        Llm            = $llm
        EmbedModel     = $embedModel   # $null = kein Ollama-Embedding nötig
        WhisperEnabled = ($stt -eq 'whispercpp')
        PiperEnabled   = ($tts -eq 'piper')
        OllamaNeeded   = ($llm -eq 'ollama') -or [bool]$embedModel
    }
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
    param(
        [Parameter(Mandatory)][hashtable]$Config,
        [Parameter(Mandatory)][string]$RepoRoot,
        [System.Collections.IDictionary]$ServerSettings = $null
    )
    $v = $Config.Values
    $whisperDir = $v['VA_WHISPER_DIR']
    if ($null -eq $ServerSettings) { $ServerSettings = Get-VaServerSettings -RepoRoot $RepoRoot }
    $prov = Get-VaProviders -ServerSettings $ServerSettings
    # Ohne Vault (weder Launcher-VA_VAULT_PATH noch OBSIDIAN_VAULT_PATH in der
    # Server-.env) ist die Vault-Suche aus → keine Embeddings, also auch kein
    # Ollama allein dafür starten.
    $vaultSet = [bool]$v['VA_VAULT_PATH'] -or [bool](Get-VaSetting $ServerSettings 'OBSIDIAN_VAULT_PATH')
    if (-not $vaultSet -and $prov.EmbedModel) {
        $prov.EmbedModel = $null
        $prov.OllamaNeeded = ($prov.Llm -eq 'ollama')
    }
    return [pscustomobject]@{
        Providers      = $prov
        WhisperEnabled = $prov.WhisperEnabled
        PiperEnabled   = $prov.PiperEnabled
        OllamaNeeded   = $prov.OllamaNeeded
        RepoRoot       = $RepoRoot
        ServerDir      = (Join-Path $RepoRoot 'apps\server')
        PiperSvcDir    = (Join-Path $RepoRoot 'services\piper')
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
        VaultPath      = $v['VA_VAULT_PATH']
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
    }
    # Vault für den Node-Server: Wissensbasis der Vault-Suche (RAG) und Basis
    # des CAMPAIGN.md-Fallbacks. Alle übrigen RAG-/Embedding-Einstellungen
    # bleiben bewusst bei apps/server/.env bzw. dem Web-Panel — ein Export hier
    # würde sie (Prozess-Env schlägt dotenv) still überstimmen.
    if ($Services.VaultPath) { $envMap['OBSIDIAN_VAULT_PATH'] = $Services.VaultPath }
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
    # Nur Dienste prüfen, die der Server laut Provider-Wahl auch braucht
    # (Get-VaProviders) — ein Objekt ohne die Flags (alte Aufrufer) = alles prüfen.
    $checkWhisper = ($null -eq $Services.PSObject.Properties['WhisperEnabled']) -or $Services.WhisperEnabled
    $checkPiper = ($null -eq $Services.PSObject.Properties['PiperEnabled']) -or $Services.PiperEnabled
    if ($checkWhisper -and -not (Test-Path -LiteralPath $Services.WhisperExe)) {
        $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Whisper'; Message = "whisper-server nicht gefunden: $($Services.WhisperExe)"; Hint = $hint }
    }
    if ($checkWhisper -and -not (Test-Path -LiteralPath $Services.WhisperModel)) {
        $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Whisper'; Message = "Whisper-Modell nicht gefunden: $($Services.WhisperModel)"; Hint = $hint }
    }
    if ($checkPiper -and -not (Test-Path -LiteralPath $Services.PiperPython)) {
        $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Piper'; Message = "Piper-Python (venv) nicht gefunden: $($Services.PiperPython)"; Hint = $hint }
    }
    if ($Config -and $checkPiper) {
        $voices = $Config.Values['PIPER_VOICES_DIR']
        if (-not $voices -or -not (Test-Path -LiteralPath $voices)) {
            $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Piper'; Message = "Stimmen-Ordner fehlt: $voices"; Hint = $hint }
        } elseif (-not (Get-ChildItem -LiteralPath $voices -Filter '*.onnx' -File -ErrorAction SilentlyContinue)) {
            $issues += [pscustomobject]@{ Level = 'Error'; Component = 'Piper'; Message = "Keine *.onnx-Stimme in $voices"; Hint = $hint }
        }
    }
    if (-not $Services.VaultPath) {
        $issues += [pscustomobject]@{ Level = 'Warn'; Component = 'Vault'; Message = 'VA_VAULT_PATH nicht gesetzt → Vault-Suche (RAG) und Kampagnen-Kontext aus'; Hint = $hint }
    } elseif (-not (Test-Path -LiteralPath $Services.VaultPath)) {
        $issues += [pscustomobject]@{ Level = 'Warn'; Component = 'Vault'; Message = "Vault-Pfad existiert nicht: $($Services.VaultPath)"; Hint = $hint }
    }
    # Elemente einzeln in die Pipeline (Aufrufer klammern mit @(...)).
    return $issues
}
