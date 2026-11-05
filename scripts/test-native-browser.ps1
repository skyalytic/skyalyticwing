# Runs the isolated Windows browser example. Does not create or publish an installer.
param([switch]$SkipBuild, [switch]$BrowserUse)
$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path $PSScriptRoot -Parent
$probeOut = Join-Path $probeRoot 'build/browser-2.0.1-work/native-probe'
if ($BrowserUse) { $probeOut = Join-Path $probeRoot 'build/browser-use-probe' }
$probeBinary = Join-Path $probeRoot 'src-tauri/target/debug/examples/browser_probe.exe'
$probeResult = Join-Path $probeOut 'results.json'
$probePreviousConfig = $env:TAURI_CONFIG
$probeServer = $null
$probeApp = $null
New-Item -ItemType Directory -Path $probeOut -Force | Out-Null
try {
    if (Get-NetTCPConnection -LocalPort 19112 -State Listen -ErrorAction SilentlyContinue) { throw 'Browser test port 19112 is occupied; no existing application will be used or stopped' }
    $probeEditionId = (Get-Content -LiteralPath (Join-Path $probeRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).identifier
    $env:TAURI_CONFIG = @{identifier=($probeEditionId + '.browserprobe');bundle=@{resources=@();externalBin=@()}} | ConvertTo-Json -Depth 4 -Compress
    Push-Location $probeRoot
    try { if (!$SkipBuild) { cargo build --manifest-path src-tauri/Cargo.toml --example browser_probe; if ($LASTEXITCODE) { throw 'Native probe compilation failed' } }; if (!(Test-Path -LiteralPath $probeBinary)) { throw 'Native probe executable is missing' } }
    finally { Pop-Location }
    $probeManifestTool = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/mt.exe" | Sort-Object FullName -Descending | Select-Object -First 1
    if (!$probeManifestTool) { throw 'Windows SDK manifest tool (mt.exe) is required for this test executable' }
    & $probeManifestTool.FullName -manifest (Join-Path $probeRoot 'src-tauri/windows/browser-probe.manifest') "-outputresource:$probeBinary;#1"
    if ($LASTEXITCODE) { throw 'Failed to add the test executable manifest' }
    Get-ChildItem (Join-Path $probeRoot 'src-tauri/windows/runtime/x64') -Filter '*.dll' | Copy-Item -Destination (Split-Path $probeBinary)
    if (Test-Path -LiteralPath $probeResult) { Remove-Item -LiteralPath $probeResult }
    $probeFixture = if ($BrowserUse) { 'scripts/browser-use-probe.cjs' } else { 'scripts/browser-native-probe.cjs' }
    $probeServer = Start-Process -FilePath (Get-Command node).Source -ArgumentList $probeFixture -WorkingDirectory $probeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $probeOut 'server.log') -RedirectStandardError (Join-Path $probeOut 'server-error.log')
    for ($probeAttempt=0; $probeAttempt -lt 40; $probeAttempt++) {
        try { Invoke-WebRequest 'http://127.0.0.1:19112/fixture' -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 100 }
    }
    $probeApp = Start-Process -FilePath $probeBinary -WindowStyle Hidden -PassThru
    $probeDeadline = (Get-Date).AddSeconds(120)
    while (!(Test-Path -LiteralPath $probeResult) -and !$probeApp.HasExited -and (Get-Date) -lt $probeDeadline) { Start-Sleep -Milliseconds 200 }
    if (!(Test-Path -LiteralPath $probeResult)) { throw 'Native browser probe did not return a result within 120 seconds' }
    $probeReport = Get-Content -LiteralPath $probeResult -Raw | ConvertFrom-Json
    $probeReport.results | Select-Object name,passed,detail | Format-Table -AutoSize
    if (@($probeReport.results | Where-Object { !$_.passed }).Count) { throw 'Native browser acceptance failed; see results.json' }
} finally {
    $env:TAURI_CONFIG = $probePreviousConfig
    if ($probeServer -and !$probeServer.HasExited) { Stop-Process -Id $probeServer.Id }
    if ($probeApp -and !$probeApp.HasExited) { Stop-Process -Id $probeApp.Id }
}
