﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿param([string]$ProcessName, [int]$ProcessId, [switch]$Maximize)

$ProcessName = $ProcessName -replace '\.exe$',''

# Use a separate .cs file to load C# code, to avoid PowerShell parser issues
# with curly braces in inline C# code
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$helperCs = Join-Path $scriptDir "WinRestoreHelper.cs"

if (Test-Path $helperCs) {
    try {
        Add-Type -Path $helperCs -ErrorAction SilentlyContinue
    } catch {}
}

# Ensure DPI-aware to get physical coordinates
try { [WinRestoreHelper]::SetProcessDPIAware() | Out-Null } catch {}

if ($ProcessId -gt 0) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
} else {
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
}

# Check if MainWindowHandle points to a valid window (area >= 100x100)
$windowValid = $false
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $r = New-Object WinRestoreHelper+RECT
    if ([WinRestoreHelper]::GetWindowRect($proc.MainWindowHandle, [ref]$r)) {
        $w = $r.R - $r.L
        $h = $r.B - $r.T
        $area = $w * $h
        if ($area -ge 10000) {
            $windowValid = $true
        } else {
            Write-Host "MainWindowHandle window too small (${w}x${h}, area=$area), will restore from tray"
        }
    }
}

if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero -and $windowValid) {
    $handle = $proc.MainWindowHandle
    $isMin = [WinRestoreHelper]::IsIconic($handle)
    if ($isMin) { [WinRestoreHelper]::ShowWindow($handle, 9) | Out-Null }
    if ($Maximize) {
        [WinRestoreHelper]::ShowWindow($handle, 3) | Out-Null
        Write-Host "ok Maximized PID=$($proc.Id) Handle=$handle"
    } else {
        [WinRestoreHelper]::SetForegroundWindow($handle) | Out-Null
        Write-Host "ok PID=$($proc.Id) Handle=$handle Restored=$isMin"
    }
    Start-Sleep -Milliseconds 500
} else {
    # MainWindowHandle=0 or window too small: launch desktop/start-menu shortcut to restore from tray
    $shell = New-Object -ComObject WScript.Shell
    $searchDirs = @(
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('DesktopDirectory'),
        [Environment]::GetFolderPath('CommonPrograms'),
        [Environment]::GetFolderPath('Programs')
    )

    $shortcutPath = $null
    $pattern = '\\' + $ProcessName + '\.exe$'
    foreach ($dir in $searchDirs) {
        if (-not (Test-Path $dir)) { continue }
        $lnks = Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
        foreach ($lnk in $lnks) {
            try {
                $sc = $shell.CreateShortcut($lnk.FullName)
                $tp = $sc.TargetPath
                if ($tp -and ($tp -match $pattern)) {
                    $shortcutPath = $lnk.FullName
                    break
                }
            } catch {}
        }
        if ($shortcutPath) { break }
    }

    if ($shortcutPath) {
        Start-Process -FilePath $shortcutPath
        Start-Sleep -Milliseconds 3000
        Write-Host "ok Launched shortcut to restore window: $shortcutPath"
    } else {
        Write-Host "No window handle and no shortcut found for $ProcessName"
        exit 1
    }
}
