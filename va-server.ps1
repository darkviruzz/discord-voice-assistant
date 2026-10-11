# select-commit.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Repo-Wurzel = Ordner dieses Skripts (kein fest verdrahteter Benutzerpfad).
Set-Location $PSScriptRoot

Write-Host "Fetching latest (pruning stale)..." -ForegroundColor Cyan
git fetch --prune 2>&1 | Out-Null

$currentBranch = (git branch --show-current 2>&1).Trim()
$isDirty = (git status --porcelain 2>&1 | Where-Object { $_ -notmatch '^\?\?' }).Count -gt 0

$localBranches = @{}
git branch --format='%(refname:short)|%(objectname:short)|%(subject)' | ForEach-Object {
    $p = $_ -split '\|', 3
    if ($p.Count -lt 3) { return }
    $n = $p[0].Trim()
    if ($n -match '^\(HEAD') { return }
    $localBranches[$n] = [PSCustomObject]@{ Hash = $p[1].Substring(0,7); Subject = $p[2] }
}

$remoteBranches = @{}
git branch -r --format='%(refname:short)|%(objectname:short)|%(subject)' | ForEach-Object {
    $p = $_ -split '\|', 3
    if ($p.Count -lt 3) { return }
    $n = $p[0].Trim()
    if ($n -match '^origin/HEAD$') { return }
    if ($n -eq 'origin') { return }
    $n = $n -replace '^origin/', ''
    if ($n -eq '') { return }
    $remoteBranches[$n] = [PSCustomObject]@{ Hash = $p[1].Substring(0,7); Subject = $p[2] }
}

$entries = @()
$allNames = (@($localBranches.Keys) + @($remoteBranches.Keys)) | Sort-Object -Unique
foreach ($name in $allNames) {
    $hasL = $localBranches.ContainsKey($name)
    $hasR = $remoteBranches.ContainsKey($name)
    $info = if ($hasL) { $localBranches[$name] } else { $remoteBranches[$name] }
    $entries += [PSCustomObject]@{
        Name = $name; Hash = $info.Hash; Subject = $info.Subject
        HasLocal = $hasL; HasRemote = $hasR
    }
}

if ($entries.Count -eq 0) {
    Write-Host "Keine Branches gefunden." -ForegroundColor Red
    $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
    exit 1
}

$selected = 0
for ($i = 0; $i -lt $entries.Count; $i++) {
    if ($entries[$i].Name -eq $currentBranch) { $selected = $i; break }
}

$done = $false

function Draw-Menu {
    Clear-Host
    Write-Host "  SELECT BRANCH TO DEPLOY" -ForegroundColor Cyan
    Write-Host "  [L/R]   L=lokal  R=remote  *=uncommitted changes  <=aktiv" -ForegroundColor DarkGray
    Write-Host "  [up/down] navigate  [Enter] select  [Q] quit`n" -ForegroundColor DarkGray

    for ($i = 0; $i -lt $entries.Count; $i++) {
        $e     = $entries[$i]
        $L     = if ($e.HasLocal)                               { 'L' } else { ' ' }
        $R     = if ($e.HasRemote)                              { 'R' } else { ' ' }
        $dChar = if ($e.Name -eq $currentBranch -and $isDirty) { '*' } else { ' ' }
        $aChar = if ($e.Name -eq $currentBranch)               { '<' } else { ' ' }
        $line  = "  [$L/$R]$dChar$aChar  {0,-45} {1}  {2}" -f $e.Name, $e.Hash, $e.Subject

        if ($i -eq $selected) {
            Write-Host ("> $line") -ForegroundColor Yellow
        } elseif ($e.Name -eq $currentBranch) {
            Write-Host ("  $line") -ForegroundColor Cyan
        } else {
            Write-Host ("  $line") -ForegroundColor Gray
        }
    }
}

while (-not $done) {
    Draw-Menu
    $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    switch ($key.VirtualKeyCode) {
        38 { if ($selected -gt 0)                  { $selected-- } }
        40 { if ($selected -lt $entries.Count - 1) { $selected++ } }
        13 { $done = $true }
        { $_ -in 81, 113 } { exit 0 }
    }
}

$chosen = $entries[$selected]
Write-Host ""
Write-Host "Selected: $($chosen.Name) @ $($chosen.Hash)" -ForegroundColor Green

if ($chosen.Name -eq $currentBranch) {
    Write-Host "Branch unveraendert - starte Services direkt." -ForegroundColor Cyan
    & .\scripts\Start-VoiceAssistant.ps1 -Mode server
    exit 0
}

if ($isDirty) {
    $stashLabel = "auto: vor checkout zu $($chosen.Name) ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
    Write-Host "Stashing uncommitted changes..." -ForegroundColor Yellow
    git stash push -m $stashLabel 2>&1 | Out-Null
    Write-Host "  Wiederherstellen wenn zurueck auf '$currentBranch': git stash pop" -ForegroundColor DarkYellow
}

Write-Host "Stopping services..." -ForegroundColor Yellow
& .\scripts\Start-VoiceAssistant.ps1 -Mode stop 2>&1 | Out-Null
Start-Sleep -Seconds 2

if ($chosen.HasLocal) {
    git checkout --quiet $chosen.Name
} else {
    git checkout --quiet -b $chosen.Name --track "origin/$($chosen.Name)"
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "Fehler beim Checkout von '$($chosen.Name)'." -ForegroundColor Red
    $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
    exit 1
}

if ($chosen.HasRemote) {
    $pullOut = git pull --quiet origin $chosen.Name 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNUNG: git pull fehlgeschlagen:" -ForegroundColor Red
        Write-Host $pullOut -ForegroundColor DarkRed
        $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
        exit 1
    }
} else {
    Write-Host "  Kein Remote-Branch - kein pull." -ForegroundColor DarkGray
}

Write-Host "Starting services..." -ForegroundColor Green
& .\scripts\Start-VoiceAssistant.ps1 -Mode server