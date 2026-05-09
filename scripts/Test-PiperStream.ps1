#Requires -Version 5.1
param(
    [string]$Text     = "In einem kleinen Dorf am Rande eines dichten Waldes lebte ein junger Junge namens Finn.",
    [string]$Model    = "high",
    [string]$PiperUrl = "http://localhost:5000"
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$OutDir  = "$env:TEMP\piper-test"
$PcmFile = "$OutDir\test.pcm"
$WavFile = "$OutDir\test.wav"
if (-not (Test-Path $OutDir)) { $null = New-Item -ItemType Directory -Path $OutDir -Force }

Write-Host ">> Teste Piper Streaming ($PiperUrl/tts/synthesize)" -ForegroundColor Cyan
Write-Host "   Text:  $Text"  -ForegroundColor DarkGray
Write-Host "   Model: $Model" -ForegroundColor DarkGray

# ---- HTTP-Request (streaming via HttpClient) ----------------------------------
$body    = [System.Text.Encoding]::UTF8.GetBytes(
    '{"text":' + (ConvertTo-Json $Text) + ',"model":"' + $Model + '","speaker_id":4}')
$handler = [System.Net.Http.HttpClientHandler]::new()
$client  = [System.Net.Http.HttpClient]::new($handler)
$content = [System.Net.Http.ByteArrayContent]::new($body)
$content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('application/json')

$response = $client.PostAsync("$PiperUrl/tts/synthesize", $content).GetAwaiter().GetResult()
if (-not $response.IsSuccessStatusCode) {
    Write-Host "   FEHLER: HTTP $($response.StatusCode)" -ForegroundColor Red
    $client.Dispose()
    exit 1
}

# ---- Header lesen -------------------------------------------------------------
$sampleRate = 22050
$ctHeader   = $response.Content.Headers.ContentType
if ($ctHeader -ne $null) {
    $contentType = $ctHeader.MediaType
} else {
    $contentType = "unbekannt"
}
$srValues = $null
if ($response.Headers.TryGetValues('X-Sample-Rate', [ref]$srValues)) {
    $sampleRate = [int]($srValues | Select-Object -First 1)
}
Write-Host "   Content-Type:  $contentType"    -ForegroundColor DarkGray
Write-Host "   X-Sample-Rate: $sampleRate Hz"  -ForegroundColor DarkGray

# ---- PCM in Datei lesen, Chunks zaehlen --------------------------------------
$stream     = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
$fileStream = [System.IO.FileStream]::new($PcmFile, [System.IO.FileMode]::Create)
$buf        = [byte[]]::new(4096)
$totalBytes = 0
$chunks     = 0

$bytesRead = $stream.Read($buf, 0, $buf.Length)
while ($bytesRead -gt 0) {
    $fileStream.Write($buf, 0, $bytesRead)
    $totalBytes += $bytesRead
    $chunks++
    $bytesRead = $stream.Read($buf, 0, $buf.Length)
}
$fileStream.Close()
$stream.Close()
$client.Dispose()

Write-Host ("   Empfangen: {0} Bytes in {1} HTTP-Chunks" -f $totalBytes, $chunks) -ForegroundColor Green

# ---- Alignment-Check ---------------------------------------------------------
if ($totalBytes % 2 -ne 0) {
    Write-Host "   !! WARNUNG: $totalBytes Bytes -- ungerade! int16-Misalignment!" -ForegroundColor Red
} else {
    $samples = $totalBytes / 2
    $durMs   = [Math]::Round($samples * 1000.0 / $sampleRate)
    Write-Host ("   OK  Alignment: {0} Samples = {1} ms bei {2} Hz" -f $samples, $durMs, $sampleRate) -ForegroundColor Green
}

# ---- WAV bauen ---------------------------------------------------------------
$pcmLen   = [int]$totalBytes
$riffSize = 36 + $pcmLen
$byteRate = $sampleRate * 2   # 1 Kanal, 16 bit

$wav = [System.IO.FileStream]::new($WavFile, [System.IO.FileMode]::Create)
$w   = [System.IO.BinaryWriter]::new($wav)
$w.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
$w.Write([int32]$riffSize)
$w.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
$w.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
$w.Write([int32]16)
$w.Write([int16]1)           # PCM
$w.Write([int16]1)           # Mono
$w.Write([int32]$sampleRate)
$w.Write([int32]$byteRate)
$w.Write([int16]2)           # BlockAlign
$w.Write([int16]16)          # BitDepth
$w.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
$w.Write([int32]$pcmLen)

$pcmIn = [System.IO.FileStream]::new($PcmFile, [System.IO.FileMode]::Open)
$pcmIn.CopyTo($wav)
$pcmIn.Close()
$w.Close()
$wav.Close()

Write-Host "   WAV:  $WavFile" -ForegroundColor Green
Write-Host ""
Write-Host ">> Oeffne WAV -- klingt es sauber ohne Rauschen/Knacksen?" -ForegroundColor Cyan
Start-Process $WavFile
