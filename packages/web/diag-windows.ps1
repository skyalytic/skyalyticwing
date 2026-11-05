$csFile = Join-Path $PSScriptRoot "WinDiag.cs"
try { Add-Type -Path $csFile -ErrorAction SilentlyContinue } catch {}

$all = [WinDiag]::ListAllVisibleWindows()
Write-Output ("total_visible_windows=" + $all.Count)
foreach ($info in $all) { Write-Output $info }
