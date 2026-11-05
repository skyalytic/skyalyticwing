param([string]$RedistDirectory)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = Join-Path $taskRoot 'src-tauri/windows/runtime/x64'

# Use the licensed MSVC redistributable directory, never DLLs copied from System32.
# App-local deployment keeps per-user/offline installs independent of admin rights.
if (-not $RedistDirectory) {
  $taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (-not (Test-Path -LiteralPath $taskVswhere)) { throw 'MSVC redistributables unavailable: install Visual Studio C++ build tools.' }
  $taskVsRoot = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $taskVsRoot) { throw 'No Visual Studio C++ toolchain found.' }
  $taskRedistRoot = Join-Path $taskVsRoot 'VC/Redist/MSVC'
  $taskVersion = Get-ChildItem -LiteralPath $taskRedistRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  $taskCrt = Get-ChildItem -LiteralPath (Join-Path $taskVersion.FullName 'x64') -Directory |
    Where-Object { $_.Name -match '^Microsoft\.VC\d+\.CRT$' } | Select-Object -First 1
  if (-not $taskCrt) { throw 'x64 MSVC CRT redistributables are missing.' }
  $RedistDirectory = $taskCrt.FullName
}
$taskNames = @('concrt140.dll','msvcp140.dll','msvcp140_1.dll','msvcp140_2.dll',
  'msvcp140_atomic_wait.dll','msvcp140_codecvt_ids.dll','vccorlib140.dll',
  'vcruntime140.dll','vcruntime140_1.dll','vcruntime140_threads.dll')
$taskFiles = foreach ($taskName in $taskNames) {
  $taskSource = Join-Path $RedistDirectory $taskName
  $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskSource
  if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "Not a verified Microsoft runtime: $taskName"
  }
  $taskBytes = [IO.File]::ReadAllBytes($taskSource)
  $taskPeOffset = [BitConverter]::ToInt32($taskBytes, 0x3c)
  if ([BitConverter]::ToUInt16($taskBytes, $taskPeOffset + 4) -ne 0x8664) { throw "Runtime is not x64: $taskName" }
  [PSCustomObject]@{ name=$taskName; source=$taskSource; version=(Get-Item -LiteralPath $taskSource).VersionInfo.FileVersion; sha256=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant() }
}
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
foreach ($taskFile in $taskFiles) { Copy-Item -LiteralPath $taskFile.source -Destination (Join-Path $taskOutput $taskFile.name) -Force }
$taskManifest = $taskFiles | Select-Object name,version,sha256 | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $taskOutput 'runtime-manifest.json'), $taskManifest, [Text.UTF8Encoding]::new($false))
Write-Output "PASS: $($taskFiles.Count) Microsoft-signed x64 runtime DLLs prepared for offline installation."
