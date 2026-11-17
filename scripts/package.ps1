# Build the zip for Chrome Web Store upload. Usage: powershell -File scripts/package.ps1
# Uses Windows built-in tar.exe (bsdtar) because Compress-Archive in PowerShell 5.1
# writes backslash paths, which the Chrome Web Store does not accept.
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content "$root\extension\manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist ("kids-safe-browsing-" + $manifest.version + ".zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
$ErrorActionPreference = 'Stop'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
Push-Location "$root\extension"
try {
  & $tar -a -c -f $zip *
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally { Pop-Location }
Write-Output "Created $zip"
