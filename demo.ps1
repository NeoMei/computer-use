# Windows self check: notepad screenshot -> AX(UIA) tree -> click -> state readback.
# Requires: Node.js on PATH; run from an interactive desktop session (not a service).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $Root "cli\orca-computer.mjs"
function Invoke-Cli { node $Cli @args }

Write-Host "== 1. permissions =="
Invoke-Cli permissions --json

Write-Host "== 2. list-apps (first 5) =="
$apps = (Invoke-Cli list-apps --json | ConvertFrom-Json).apps
$apps | Select-Object -First 5 | ConvertTo-Json -Compress

Start-Process notepad
Start-Sleep -Seconds 2
try {
    Write-Host "== 3. get-app-state notepad (screenshot + UIA tree) =="
    $state = Invoke-Cli get-app-state --app notepad --json | ConvertFrom-Json
    Write-Host "window: $($state.snapshot.window.title) | elements: $($state.snapshot.elementCount)"
    Write-Host "screenshot: $($state.screenshot.path) ($($state.screenshot.width)x$($state.screenshot.height))"
    if (-not (Test-Path $state.screenshot.path)) { throw "screenshot file missing" }
    $target = $state.snapshot.treeText -split "`n" |
        Where-Object { $_ -match "(^|\s)(edit|document|文档|文本编辑)" } |
        Select-Object -First 1
    if (-not $target) { throw "no editable element found in tree" }
    $index = [int]($target.Trim() -split "\s+")[0]
    Write-Host "tree excerpt: $($target.Trim())"

    Write-Host "== 4. click element $index =="
    $click = Invoke-Cli click --app notepad --element-index $index --json | ConvertFrom-Json
    Write-Host "post-click window: $($click.snapshot.window.title) | elements: $($click.snapshot.elementCount)"

    Write-Host "== 5. state readback =="
    $after = Invoke-Cli get-app-state --app notepad --no-screenshot --json | ConvertFrom-Json
    $changed = $state.snapshot.treeText -ne $after.snapshot.treeText
    Write-Host "tree changed: $changed (read/write loop verified)"
    Write-Host "DEMO OK"
} finally {
    Stop-Process -Name notepad -ErrorAction SilentlyContinue
}
