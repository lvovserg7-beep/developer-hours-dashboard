$ErrorActionPreference = "Stop"
$dashboard = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$root = Split-Path $dashboard -Parent
$envFile = Join-Path $dashboard ".env"
$user = $null
$pass = $null
foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*ODATA_DB_ECOTIDY_USERNAME=(.*)$') { $user = $matches[1].Trim().Trim('"').Trim("'") }
    if ($line -match '^\s*ODATA_DB_ECOTIDY_PASSWORD=(.*)$') { $pass = $matches[1].Trim().Trim('"').Trim("'") }
}
if (-not $user -or -not $pass) { throw "В dashboard/.env нет учётных данных ecotidy" }

$epf = Join-Path $root "tools\vanessa-automation\single\vanessa-automation-single.epf"
$params = Join-Path $PSScriptRoot "VAParams.json"
$exe = "C:\Program Files\1cv8\8.5.1.1343\bin\1cv8c.exe"
$c = "StartFeaturePlayer;ShowMainForm;DisableLoadConfig;DisableUserSettingsLoader;VAParams=$params"

Remove-Item -LiteralPath (Join-Path $dashboard "reports\vanessa-status.txt") -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $dashboard "reports\vanessa-run.log") -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $dashboard "reports\vanessa-forecast-cases.log") -ErrorAction SilentlyContinue

# Закрыть только прошлые незавершённые запуски Ванессы (по командной строке /Execute этой обработки).
Get-CimInstance Win32_Process -Filter "Name='1cv8c.exe'" | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine -like "*vanessa-automation-single.epf*") {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Start-Process -FilePath $exe -ArgumentList @(
    "ENTERPRISE",
    "/WS", "https://demo.alsn.ru/ecotidy/",
    "/N", $user,
    "/P", $pass,
    "/DisableStartupDialogs",
    "/Execute", $epf,
    "/C", $c
)
Write-Output "STARTED"
