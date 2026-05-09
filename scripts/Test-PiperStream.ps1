#Requires -Version 5.1
<#
.SYNOPSIS
    Testet den Piper /tts/synthesize Streaming-Endpoint isoliert.
    Speichert das rohe PCM als .wav und öffnet es zur Überprüfung.

.PARAMETER Text
    Der zu synthetisierende Text (Standard: kurzer Testsatz).

.PARAMETER Model
    Voice-Modell: 'emotional' oder 'high' (Standard: 'high').

.PARAMETER PiperUrl
    Basis-URL des Piper-Servers (Standard: http://localhost:5000).

.EXAMPLE
    .\scripts\Test-PiperStream.ps1
    .\scripts\Test-PiperStream.ps1 -Text "In einem kleinen Dorf am Rande eines Waldes."
    .\scripts\Test-PiperStream.ps1 -Text "Langer Text..." -Model emotional
#>
param(
    [string]$Text      = "In einem kleinen Dorf am Rande eines dichten Waldes lebte ein junger Junge namens Finn.",
    [string]$Model     = "high",
    [string]$PiperUrl  = "http://localhost:5000"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$OutDir  = "$env:TEMP\piper-test"
$PcmFile = "$OutDir\test.pcm"
$WavFile = "$OutDir\test.wav"
if (-not (Test-Path $OutDir)) { $null = New-Item -ItemType Directory -Path $OutDir -Force }

Write-Host ">> Teste Piper Streaming-Endpoint ..." -ForegroundColor Cyan
Write-Host "   URL:   $PiperUrl/tts/synthesize" -ForegroundColor DarkGray
Write-Host "   Text:  $Text" -ForegroundColor DarkGray
Write-Host "   Model: $Model" -ForegroundColor DarkGray

# ── Streaming-Request via .NET HttpClient ────────────────────────────────────
# (Invoke-WebRequest puffert alles — HttpClient streamt wirklich)
$body = @{ text = $Text; model = $Model; speaker_id = 4 } | ConvertTo-Json

try {
    $handler  = [System.Net.Http.HttpClientHandler]::new()
    $client   = [System.Net.Http.HttpClient]::new($handler)
    $content  = [System.Net.Http.StringContent]::new($body, [System.Text.Encoding]::UTF8, 'application/json')
    $response = $client.PostAsync("$PiperUrl/tts/synthesize", $content).GetAwaiter().GetResult()

    if (-not $response.IsSuccessStatusCode) {
        Write-Host "   FEHLER: HTTP $($response.StatusCode)" -ForegroundColor Red
        exit 1
    }

    # Header lesen
    $sampleRate = 22050
    if ($response.Headers.TryGetValues('X-Sample-Rate', [ref]$null)) {
        $vals = $response.Headers.GetValues('X-Sample-Rate')
        $sampleRate = [int]($vals | Select-Object -First 1)
    }
    $contentType = $response.Content.Headers.ContentType.MediaType
    Write-Host "   Content-Type: $contentType" -ForegroundColor DarkGray
    Write-Host "   X-Sample-Rate: $sampleRate Hz" -ForegroundColor DarkGray

    # PCM-Stream in Datei schreiben
    $stream    = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $fileStream = [System.IO.FileStream]::new($PcmFile, [System.IO.FileMode]::Create)
    $buf        = [byte[]]::new(4096)
    $totalBytes = 0
    $chunkCount = 0
    while (($read = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
        $fileStream.Write($buf, 0, $read)
        $totalBytes += $read
        $chunkCount++
    }
    $fileStream.Close()
    $stream.Close()
    $client.Dispose()

    Write-Host "   OK  $chunkCount HTTP-Chunks, $totalBytes Bytes PCM empfangen" -ForegroundColor Green

    # Byte-Alignment prüfen
    if ($totalBytes % 2 -ne 0) {
        Write-Host "   !!  WARNUNG: PCM-Größe ungerade ($totalBytes Bytes) — int16-Misalignment!" -ForegroundColor Red
    } else {
        $samples = $totalBytes / 2
        $durationMs = [Math]::Round($samples * 1000.0 / $sampleRate)
        Write-Host "   OK  Alignment: $samples Samples, ~${durationMs}ms Audio bei $sampleRate Hz" -ForegroundColor Green
    }

} catch {
    Write-Host "   FEHLER beim Request: $_" -ForegroundColor Red
    exit 1
}

# ── WAV-Header schreiben ─────────────────────────────────────────────────────
$channels   = 1
$bitDepth   = 16
$byteRate   = $sampleRate * $channels * ($bitDepth / 8)
$blockAlign = $channels * ($bitDepth / 8)
$pcmBytes   = (Get-Item $PcmFile).Length
$dataChunk  = [int]$pcmBytes
$riffSize   = 36 + $dataChunk

$wav = [System.IO.FileStream]::new($WavFile, [System.IO.FileMode]::Create)
$w   = [System.IO.BinaryWriter]::new($wav)

$w.Write([System.Text.Encoding]::ASCII.GetBytes("RIFF"))
$w.Write([int32]$riffSize)
$w.Write([System.Text.Encoding]::ASCII.GetBytes("WAVE"))
$w.Write([System.Text.Encoding]::ASCII.GetBytes("fmt "))
$w.Write([int32]16)          # chunk size
$w.Write([int16]1)           # PCM
$w.Write([int16]$channels)
$w.Write([int32]$sampleRate)
$w.Write([int32]$byteRate)
$w.Write([int16]$blockAlign)
$w.Write([int16]$bitDepth)
$w.Write([System.Text.Encoding]::ASCII.GetBytes("data"))
$w.Write([int32]$dataChunk)

# PCM-Daten anhängen
$pcm = [System.IO.FileStream]::new($PcmFile, [System.IO.FileMode]::Open)
$pcm.CopyTo($wav)
$pcm.Close()
$w.Close()
$wav.Close()

Write-Host "   OK  WAV geschrieben: $WavFile" -ForegroundColor Green
Write-Host ""
Write-Host ">> Öffne WAV in Standard-Player ..." -ForegroundColor Cyan
Start-Process $WavFile
Write-Host "   Hörtest: Audio sauber ohne Rauschen? Kein Knacksen?" -ForegroundColor Yellow
Write-Host "   PCM-Datei: $PcmFile" -ForegroundColor DarkGray
