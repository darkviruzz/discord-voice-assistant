# va.ps1 — windows-native local profile for the `va` CLI.
# Wraps scripts/Start-VoiceAssistant.ps1 (whisper-vulkan + piper-directml +
# ollama + rag as native processes, node server) instead of reimplementing it.
# Contract: docs/deploy-architecture.md.
#
#   ./deploy/va.ps1 setup   -> scripts/Setup-VoiceAssistant.ps1 (interaktiv)
#   ./deploy/va.ps1 doctor  -> scripts/Setup-VoiceAssistant.ps1 -Check
#   ./deploy/va.ps1 up      -> Start-VoiceAssistant.ps1 -Mode silent
#   ./deploy/va.ps1 down    -> Start-VoiceAssistant.ps1 -Mode stop
#   ./deploy/va.ps1 status  -> Start-VoiceAssistant.ps1 -Mode check
#   ./deploy/va.ps1 logs    -> tail the newest logs in %TEMP%\va-logs
#   ./deploy/va.ps1 env     -> effective native config + where each value comes from
#
# Config layering lives in scripts/lib/VaLocalConfig.ps1 and is applied by
# Start-VoiceAssistant.ps1 itself, so the bot's SSH autostart (which calls the
# start script directly) sees exactly the same values as `va.ps1 up`.
param(
    [Parameter(Position = 0)]
    [ValidateSet("setup", "doctor", "up", "down", "status", "logs", "env")]
    [string]$Command = "status"
)

$ErrorActionPreference = "Stop"
$DeployDir = $PSScriptRoot
$RepoRoot  = Split-Path $DeployDir -Parent
$ScriptsDir = Join-Path $RepoRoot "scripts"
$StartPs1  = Join-Path $ScriptsDir "Start-VoiceAssistant.ps1"
$SetupPs1  = Join-Path $ScriptsDir "Setup-VoiceAssistant.ps1"
. (Join-Path $ScriptsDir "lib\VaLocalConfig.ps1")

switch ($Command) {
    "setup"  { & $SetupPs1; exit $LASTEXITCODE }
    "doctor" { & $SetupPs1 -Check; exit $LASTEXITCODE }
    "env" {
        $cfg = Get-VaLocalConfig -RepoRoot $RepoRoot
        $present = if (Test-Path $cfg.DeployEnvPath) { "(present)" } else { "(MISSING - run: va.ps1 setup)" }
        Write-Host "[va.ps1] deploy env file: $($cfg.DeployEnvPath) $present"
        foreach ($k in ($cfg.Values.Keys | Sort-Object)) {
            "{0,-24} = {1,-55} # {2}" -f $k, $cfg.Values[$k], $cfg.Sources[$k]
        }
    }
    "up" {
        if (-not (Test-Path $StartPs1)) { throw "not found: $StartPs1" }
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
        $cfg = Get-VaLocalConfig -RepoRoot $RepoRoot
        $logDir = $cfg.Values['VA_LOG_DIR']
        if (-not (Test-Path $logDir)) { throw "no logs yet ($logDir missing) - run 'va.ps1 up' first" }
        Write-Host "[va.ps1] tailing $logDir\server.log (Ctrl+C to stop; whisper.log/piper.log/rag.log live beside it)"
        Get-Content -Path (Join-Path $logDir "server.log") -Tail 50 -Wait
    }
}
