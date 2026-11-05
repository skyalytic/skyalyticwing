param([Parameter(Mandatory=$true)][string]$InstallDirectory)
$ErrorActionPreference = 'Stop'
$wingNodePath = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'node.exe'))
for ($wingAttempt = 0; $wingAttempt -lt 20; $wingAttempt++) {
    $wingDesktop = Get-Process SkyalyticWing,SkyalyticClaw,SkyalyticWingCommunity,SkyalyticWingEnterprise -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and [string]::Equals([IO.Path]::GetDirectoryName($_.Path), [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
    $wingRuntime = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $wingNodePath, [StringComparison]::OrdinalIgnoreCase) }
    if (-not $wingDesktop -and -not $wingRuntime) { exit 0 }
    Start-Sleep -Milliseconds 500
}
exit 1
