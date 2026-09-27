# Temporary, account-free iPad HTTPS preview. No Windows service or autostart.
$ErrorActionPreference = 'Stop'
$previewRoot = Split-Path -Parent $PSScriptRoot
$previewDir = Join-Path $previewRoot '.local'
$previewBinary = Join-Path $previewDir 'cloudflared.exe'
if (-not (Test-Path -LiteralPath $previewBinary)) { throw 'The verified cloudflared binary is missing from .local. See the README.' }
$previewLog = Join-Path $previewDir ('tunnel-' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + '.log')
$previewProcess = Start-Process -FilePath $previewBinary -ArgumentList @('tunnel', '--no-autoupdate', '--url', 'http://localhost:3000') -WorkingDirectory $previewRoot -WindowStyle Hidden -RedirectStandardError $previewLog -PassThru
$previewUrl = $null
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if ($previewProcess.HasExited) { throw ('Tunnel exited. Inspect ' + $previewLog) }
  if (Test-Path -LiteralPath $previewLog) {
    $previewText = [string](Get-Content -LiteralPath $previewLog -Raw)
    $previewMatch = [regex]::Match($previewText, 'https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com')
    if ($previewMatch.Success) { $previewUrl = [Uri]$previewMatch.Value; break }
  }
  Start-Sleep -Milliseconds 500
}
if (-not $previewUrl) { Stop-Process -Id $previewProcess.Id; throw 'No preview URL was returned within 20 seconds.' }
[IO.File]::WriteAllText((Join-Path $previewDir 'preview-host.txt'), $previewUrl.Host)
Write-Output ('iPad URL: ' + $previewUrl.AbsoluteUri)
Write-Output ('Tunnel PID: ' + $previewProcess.Id + '. Stop it with: Stop-Process -Id ' + $previewProcess.Id)
Write-Output 'Restart npm run dev to allow this exact hostname. Get the pairing code from the laptop app.'
