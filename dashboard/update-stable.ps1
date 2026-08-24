$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$tag = if ($args.Count -ge 1 -and $args[0]) {
  [string]$args[0]
} elseif (Test-Path (Join-Path $root "STABLE")) {
  (Get-Content (Join-Path $root "STABLE") -Raw).Trim().TrimStart([char]0xFEFF)
} else {
  ""
}

if (-not $tag) {
  Write-Host "No stable tag. Pass it: update-stable.cmd v1.4.0"
  exit 1
}

if (-not (Test-Path (Join-Path $root ".git"))) {
  Write-Host "This folder is not a git clone (ZIP copy)."
  Write-Host "One-time on the production PC:"
  Write-Host "  1. Stop start.cmd"
  Write-Host "  2. Copy dashboard\.env and dashboard\users.json aside"
  Write-Host "  3. Rename this folder (example: developer-hours-dashboard.bak)"
  Write-Host "  4. git clone --branch $tag https://github.com/lvovserg7-beep/developer-hours-dashboard.git"
  Write-Host "  5. Copy .env and users.json back into dashboard\"
  Write-Host "  6. Run dashboard\start.cmd"
  Write-Host "Do not unpack a ZIP from the Cursor project folder."
  exit 1
}

Write-Host "Fetching tags..."
git fetch --tags origin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Checking out $tag ..."
git checkout --force $tag
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Now at $tag. dashboard\.env and dashboard\users.json stay local (not in git)."
Write-Host "Start the app: dashboard\start.cmd"
exit 0
