#Requires -Version 5.1
# Selbsttest für scripts/lib/VaLocalConfig.ps1 (ohne Pester, läuft unter
# Windows PowerShell 5.1 und pwsh 7 auf Linux/CI):
#   pwsh -NoProfile -File scripts/tests/VaLocalConfig.Tests.ps1
# Exit-Code = Anzahl fehlgeschlagener Prüfungen.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repo (Join-Path 'scripts' (Join-Path 'lib' 'VaLocalConfig.ps1')))
$fail = 0
function Check($name, $cond) { if ($cond) { "ok   $name" } else { "FAIL $name"; $script:fail++ } }
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('va-config-test-' + [guid]::NewGuid().ToString('N')); Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue; New-Item -ItemType Directory $t | Out-Null

# Read-VaEnvFile: quotes, export, comments, invalid keys, BOM
[IO.File]::WriteAllText("$t/a.env", "$([char]0xFEFF)# c`r`nexport FOO=`"bar baz`"`r`nlower=x`r`nEMPTY=`r`nQ='it''s'`r`n =nokey`r`n")
$m = Read-VaEnvFile "$t/a.env"
Check 'read quoted+export' ($m['FOO'] -eq 'bar baz')
Check 'read bom first key' ($m.Contains('FOO'))
Check 'skip lowercase key' (-not $m.Contains('lower'))
Check 'empty value' ($m.Contains('EMPTY') -and $m['EMPTY'] -eq '')
Check 'missing file -> empty' ((Read-VaEnvFile "$t/nope.env").Count -eq 0)

# Set-VaEnvFileValues: replace active, activate commented template, append, preserve rest, CRLF, backup
[IO.File]::WriteAllText("$t/s.env", "# doc for A`r`nA=1`r`n# B doc`r`n# B=/pfad/zum/vault`r`nKEEP=yes`r`n")
$ch = Set-VaEnvFileValues -Path "$t/s.env" -Values ([ordered]@{ A = '2'; B = 'C:\Vault'; NEW = 'n' })
$txt = [IO.File]::ReadAllText("$t/s.env")
Check 'changed keys' (($ch -join ',') -eq 'A,B,NEW')
Check 'active replaced' ($txt -match "(?m)^A=2`r$")
Check 'template activated in place' ($txt -match "# B doc`r`nB=C:\\Vault`r`n")
Check 'keep untouched' ($txt -match "KEEP=yes")
Check 'appended under header' ($txt -match "# --- gesetzt von scripts/Setup-VoiceAssistant.ps1 ---`r`nNEW=n`r`n$")
Check 'crlf kept' (-not ($txt -match "[^`r]`n"))
Check 'no bom written' ([IO.File]::ReadAllBytes("$t/s.env")[0] -ne 0xEF)
Check 'backup created' (@(Get-ChildItem $t -Filter 's.env.bak-*').Count -eq 1)
$ch2 = Set-VaEnvFileValues -Path "$t/s.env" -Values ([ordered]@{ A = '2' })
Check 'idempotent no-op' ($ch2.Count -eq 0 -and @(Get-ChildItem $t -Filter 's.env.bak-*').Count -eq 1)
$ch3 = Set-VaEnvFileValues -Path "$t/sub/new.env" -Values ([ordered]@{ X = '1' })
Check 'creates file+dir' ((Test-Path "$t/sub/new.env") -and ($ch3 -join ',') -eq 'X')
Set-VaEnvFileValues -Path "$t/sub/new.env" -Values ([ordered]@{ Y = '2' }) | Out-Null
$c = [IO.File]::ReadAllText("$t/sub/new.env")
Check 'header not duplicated' (([regex]::Matches($c, 'gesetzt von')).Count -eq 1)

# Layering: defaults < profile < deploy.env < process env; unknown keys ignored; example layer ignored
$fakeRepo = "$t/repo"; New-Item -ItemType Directory "$fakeRepo/deploy/env","$fakeRepo/apps/server" -Force | Out-Null
"OLLAMA_URL=http://ollama:11434`nWHISPER_URL=http://compose:1" | Set-Content "$fakeRepo/deploy/.env.example"
"VA_WHISPER_EXE=prof.exe`nTTS_URL=http://localhost:5555" | Set-Content "$fakeRepo/deploy/env/windows-native.env"
# Keys of the removed Python RAG service in an old deploy.env are ignored now.
"VA_WHISPER_EXE=host.exe`nVA_VAULT_PATH=$t/vault`nUNRELATED=1`nVA_RAG_ENABLED=1`nVA_RAG_PYTHON=x`nRAG_URL=http://localhost:5001`nCHROMA_DIR=c`nRAG_EMBED_MODEL=m" | Set-Content "$t/deploy.env"
"PORT=7777" | Set-Content "$fakeRepo/apps/server/.env"
$env:VA_DEPLOY_ENV = "$t/deploy.env"; $env:WHISPER_URL = 'http://localhost:9999'
$cfg = Get-VaLocalConfig -RepoRoot $fakeRepo
Check 'deploy.env beats profile' ($cfg.Values['VA_WHISPER_EXE'] -eq 'host.exe' -and $cfg.Sources['VA_WHISPER_EXE'] -eq 'deploy.env')
Check 'profile beats default' ($cfg.Values['TTS_URL'] -eq 'http://localhost:5555')
Check 'process env wins' ($cfg.Values['WHISPER_URL'] -eq 'http://localhost:9999' -and $cfg.Sources['WHISPER_URL'] -eq 'process-env')
Check 'example layer ignored' ($cfg.Values['OLLAMA_URL'] -eq 'http://localhost:11434')
Check 'unknown key ignored' (-not $cfg.Values.Contains('UNRELATED'))
Check 'legacy RAG keys ignored' (@('VA_RAG_ENABLED', 'VA_RAG_PYTHON', 'RAG_URL', 'CHROMA_DIR', 'RAG_EMBED_MODEL' | Where-Object { $cfg.Values.Contains($_) }).Count -eq 0)
Check 'server PORT picked up' ($cfg.Values['VA_SERVER_PORT'] -eq '7777')
Remove-Item Env:\WHISPER_URL

# Resolve-VaServices + child env (RAG runs inside the node server: only the vault is exported)
New-Item -ItemType Directory "$t/vault" | Out-Null
$svc = Resolve-VaServices -Config $cfg -RepoRoot $fakeRepo
Check 'ports from urls' ($svc.PiperPort -eq 5555 -and $svc.WhisperPort -eq 9999 -and $svc.ServerPort -eq 7777)
Check 'no rag service' (-not ($svc.PSObject.Properties.Name -match '^Rag'))
$ce = Get-VaChildEnv -Config $cfg -Services $svc
Check 'vault exported for the server' ($ce['OBSIDIAN_VAULT_PATH'] -eq "$t/vault")
Check 'no python-rag env' (@('VAULT_PATH', 'RAG_URL', 'RAG_PORT', 'CHROMA_DIR', 'EMBED_MODEL' | Where-Object { $ce.Contains($_) }).Count -eq 0)
$cfg.Values['VA_VAULT_PATH'] = ''
Check 'no vault -> not exported' (-not (Get-VaChildEnv -Config $cfg -Services (Resolve-VaServices -Config $cfg -RepoRoot $fakeRepo)).Contains('OBSIDIAN_VAULT_PATH'))
$cfg.Values['VA_VAULT_PATH'] = "$t/vault"

# Embedding model the server's vault RAG needs in Ollama (apps/server/.env < panel overrides)
Check 'embed default' ((Get-VaEmbedModel -ServerSettings ([ordered]@{})) -eq 'nomic-embed-text')
Check 'embed from env' ((Get-VaEmbedModel -ServerSettings ([ordered]@{ EMBED_MODEL = ' bge-m3 ' })) -eq 'bge-m3')
Check 'embed: rag off' ($null -eq (Get-VaEmbedModel -ServerSettings ([ordered]@{ RAG_ENABLED = ' False ' })))
Check 'embed: openai provider' ($null -eq (Get-VaEmbedModel -ServerSettings ([ordered]@{ EMBED_PROVIDER = 'OpenAI' })))
Check 'rag on by default' (-not (Test-VaRagOff -ServerSettings ([ordered]@{ RAG_ENABLED = '' })))
"EMBED_MODEL=from-env`nRAG_ENABLED=true" | Set-Content "$fakeRepo/apps/server/.env"
$ss = Get-VaServerSettings -RepoRoot $fakeRepo
Check 'server settings from .env' ($ss['EMBED_MODEL'] -eq 'from-env')
New-Item -ItemType Directory "$fakeRepo/apps/server/data" -Force | Out-Null
'{"version":1,"server":{"EMBED_MODEL":"from-panel"},"bot":{}}' | Set-Content "$fakeRepo/apps/server/data/config.overrides.json"
Check 'panel override beats .env' ((Get-VaEmbedModel -ServerSettings (Get-VaServerSettings -RepoRoot $fakeRepo)) -eq 'from-panel')
'{ kaputt' | Set-Content "$fakeRepo/apps/server/data/config.overrides.json"
Check 'broken overrides ignored' ((Get-VaServerSettings -RepoRoot $fakeRepo)['EMBED_MODEL'] -eq 'from-env')

# Assignments escape quotes
$as = @(ConvertTo-VaEnvAssignments -EnvMap ([ordered]@{ P = "C:\O'Brien\x"; E = '' }))
Check 'quote escaped' ($as.Count -eq 1 -and $as[0] -eq "`$env:P = 'C:\O''Brien\x'")
$sb = [scriptblock]::Create($as[0]); & $sb
Check 'assignment round-trips' ($env:P -eq "C:\O'Brien\x")

# Test-VaServiceConfig
$issues = Test-VaServiceConfig -Services $svc -Config $cfg
Check 'issues: whisper exe error' (@($issues | Where-Object { $_.Component -eq 'Whisper' -and $_.Level -eq 'Error' }).Count -eq 2)
Check 'issues: piper error' (@($issues | Where-Object { $_.Component -eq 'Piper' -and $_.Level -eq 'Error' }).Count -ge 1)
Check 'issues: vault ok, no rag issues' (@($issues | Where-Object { $_.Component -in @('Vault', 'RAG') }).Count -eq 0)
$svc.VaultPath = "$t/none"
Check 'issues: missing vault warns' (@(Test-VaServiceConfig -Services $svc -Config $cfg | Where-Object { $_.Component -eq 'Vault' -and $_.Level -eq 'Warn' }).Count -eq 1)
Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue
Remove-Item Env:\VA_DEPLOY_ENV -ErrorAction SilentlyContinue
"`n$fail failure(s)"
exit $fail
