# va.ps1 — windows-native local profile for the `va` CLI.
# Wraps scripts/Start-VoiceAssistant.ps1 (whisper-vulkan + piper-directml +
# ollama as native processes, node server) instead of reimplementing it.
# Contract: docs/deploy-architecture.md.
#
#   ./deploy/va.ps1 up      -> Start-VoiceAssistant.ps1 -Mode silent
#   ./deploy/va.ps1 down    -> Start-VoiceAssistant.ps1 -Mode stop
#   ./deploy/va.ps1 status  -> Start-VoiceAssistant.ps1 -Mode check
#   ./deploy/va.ps1 logs    -> tail the newest logs in %TEMP%\va-logs
#   ./deploy/va.ps1 env     -> effective layered env (secrets masked)
#
# Env layering before `up` (highest wins): process env > $env:VA_DEPLOY_ENV
# (default %USERPROFILE%\.config\va\deploy.env) > deploy/env/windows-native.env
# > deploy/.env.example. Values are exported into the process environment so
# child services see them; apps/server additionally reads its own
# apps/server/.env via dotenv (dotenv never overrides process env — the layers
# win where both define a key).
param(
    [Parameter(Position = 0)]
    [ValidateSet("up", "down", "status", "logs", "env")]
    [string]$Command = "status"
)

$ErrorActionPreference = "Stop"
$DeployDir = $PSScriptRoot
$RepoRoot  = Split-Path $DeployDir -Parent
$StartPs1  = Join-Path $RepoRoot "scripts\Start-VoiceAssistant.ps1"

function Get-DeployEnvPath {
    if ($env:VA_DEPLOY_ENV) { return $env:VA_DEPLOY_ENV }
    return (Join-Path $env:USERPROFILE ".config\va\deploy.env")
}

# Parse a KEY=VALUE env file (same rules as deploy/scripts/lib-env.sh: no code
# execution, KEY of [A-Z_][A-Z0-9_]*, one layer of quotes stripped).
function Read-EnvFile {
    param([string]$Path)
    $map = [ordered]@{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content -Path $Path) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        if ($t.StartsWith("export ")) { $t = $t.Substring(7) }
        $eq = $t.IndexOf("=")
        if ($eq -lt 1) { continue }
        $key = $t.Substring(0, $eq)
        if ($key -cnotmatch '^[A-Z_][A-Z0-9_]*$') { continue }
        $val = $t.Substring($eq + 1)
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or
            ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            if ($val.Length -ge 2) { $val = $val.Substring(1, $val.Length - 2) }
        }
        $map[$key] = $val
    }
    return $map
}

function Test-SecretName {
    param([string]$Name)
    return ($Name -match '_KEY|_SECRET|_PAT($|_)|_BEARER|_TOKEN|PRIVATE')
}

# Merge layers; remember each key's source. Process env wins (never overwritten).
function Get-MergedEnv {
    $layers = @(
        @{ Label = "example";                File = (Join-Path $DeployDir ".env.example") }
        @{ Label = "profile:windows-native"; File = (Join-Path $DeployDir "env\windows-native.env") }
        @{ Label = "deploy.env";             File = (Get-DeployEnvPath) }
    )
    $merged = @{}
    foreach ($layer in $layers) {
        $map = Read-EnvFile -Path $layer.File
        foreach ($k in $map.Keys) {
            $merged[$k] = @{ Value = $map[$k]; Source = $layer.Label }
        }
    }
    foreach ($k in @($merged.Keys)) {
        $existing = [Environment]::GetEnvironmentVariable($k)
        if ($null -ne $existing) {
            $merged[$k] = @{ Value = $existing; Source = "process-env" }
        }
    }
    return $merged
}

function Set-MergedEnv {
    $merged = Get-MergedEnv
    foreach ($k in $merged.Keys) {
        if ($merged[$k].Source -ne "process-env") {
            [Environment]::SetEnvironmentVariable($k, $merged[$k].Value)
        }
    }
    return $merged
}

switch ($Command) {
    "env" {
        $merged = Get-MergedEnv
        $deployEnv = Get-DeployEnvPath
        $present = if (Test-Path $deployEnv) { "(present)" } else { "(MISSING)" }
        Write-Host "[va.ps1] deploy env file: $deployEnv $present"
        foreach ($k in ($merged.Keys | Sort-Object)) {
            $v = $merged[$k].Value
            if ((Test-SecretName $k) -and $v) { $v = "«redacted»" }
            "{0,-28} = {1,-45} # {2}" -f $k, $v, $merged[$k].Source
        }
    }
    "up" {
        if (-not (Test-Path $StartPs1)) { throw "not found: $StartPs1" }
        $null = Set-MergedEnv
        & $StartPs1 -Mode silent
    }
    "down" {
        if (-not (Test-Path $StartPs1)) { throw "not found: $StartPs1" }
        & $StartPs1 -Mode stop
    }
    "status" {
        if (-not (Test-Path $StartPs1)) { throw "not found: $StartPs1" }
        & $StartPs1 -Mode check
    }
    "logs" {
        $logDir = Join-Path $env:TEMP "va-logs"
        if (-not (Test-Path $logDir)) { throw "no logs yet ($logDir missing) — run 'va.ps1 up' first" }
        Write-Host "[va.ps1] tailing $logDir\server.log (Ctrl+C to stop; whisper.log/piper.log live beside it)"
        Get-Content -Path (Join-Path $logDir "server.log") -Tail 50 -Wait
    }
}
