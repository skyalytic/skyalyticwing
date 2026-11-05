param(
    [Parameter(Mandatory=$false)][int]$TargetPid = 0,
    [Parameter(Mandatory=$false)][string]$Title = '',
    [Parameter(Mandatory=$false)][string]$ProcessName = '',
    [Parameter(Mandatory=$true)][ValidateSet('rect','maximize','restore','foreground','restorehidden')][string]$Action
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$csFile = Join-Path $scriptDir "WinMgmt.cs"

if (-not (Test-Path $csFile)) {
    Write-Output "fail:no_cs_file"
    exit 1
}

try {
    Add-Type -Path $csFile -ErrorAction SilentlyContinue
}
catch {
    # Add-Type may fail if class already loaded; ignore
}

# restorehidden: 恢复最小化到系统托盘的隐藏窗口（如微信4.x 收起到托盘后主窗口 IsWindowVisible=false）
# 遍历进程所有 PID，用 EnumWindows（含隐藏窗口）按 PID+标题匹配，找到后 SW_SHOW + SW_RESTORE + 置前台
if ($Action -eq 'restorehidden') {
    $targetPids = @()
    if ($ProcessName -ne '') {
        $targetPids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    } elseif ($TargetPid -gt 0) {
        $targetPids = @($TargetPid)
    }
    if ($targetPids.Count -eq 0) {
        Write-Output "fail:no_process name=$ProcessName pid=$TargetPid"
        exit 1
    }
    foreach ($p in $targetPids) {
        $hwnd = [WinMgmt]::FindWindowByPidTitleIncludeHidden($p, $Title)
        if ($hwnd -ne [IntPtr]::Zero) {
            [WinMgmt]::ShowWindow($hwnd, 5) | Out-Null   # SW_SHOW (make hidden window visible)
            Start-Sleep -Milliseconds 300
            # Only SW_RESTORE if actually minimized — SW_RESTORE on a normal Chromium/Electron window
            # causes GPU rendering to freeze → black screen (QQ, 企业微信)
            if ([WinMgmt]::IsIconic($hwnd)) {
                [WinMgmt]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
                Start-Sleep -Milliseconds 500
            }
            $fgResult = [WinMgmt]::SetForegroundAggressive($hwnd)
            $titleNow = [WinMgmt]::GetWindowTextString($hwnd)
            Write-Output "ok hwnd=$hwnd pid=$p fg=$fgResult title=$titleNow"
            exit 0
        }
    }
    Write-Output "fail:no_hidden_window name=$ProcessName title=$Title"
    exit 1
}

# Sightflow-style: match window by TITLE first (multi-process apps like WXWork
# have many PIDs and only one owns the real main window; PID-based lookup is unreliable)
$largestHwnd = [IntPtr]::Zero

if ($Title -ne '') {
    $largestHwnd = [WinMgmt]::FindLargestWindowByTitle($Title)
    if ($largestHwnd -eq [IntPtr]::Zero) {
        Write-Output "fail:no_window_by_title title=$Title"
        exit 1
    }
} else {
    if ($TargetPid -le 0) {
        Write-Output "fail:no_pid_or_title"
        exit 1
    }

    # Check if process exists
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Output "fail:no_process pid=$TargetPid"
        exit 1
    }

    # Find largest visible window via EnumWindows (filter out windows < 100x100)
    # First, try to find the window by process name and title match
    $procName = $proc.ProcessName
    $titleMap = @{
        'WXWork' = '企业微信'
        'WeChat' = '微信'
        'Weixin' = '微信'
        'QQ' = 'QQ'
        'DingTalk' = '钉钉'
        'Lark' = '飞书'
    }
    $expectedTitle = $titleMap[$procName]

    $largestHwnd = [WinMgmt]::FindLargestVisibleWindow($TargetPid)
    if ($largestHwnd -eq [IntPtr]::Zero) {
        # No valid window found (all too small); caller should use restore-window.ps1
        Write-Output "fail:no_valid_window"
        exit 1
    }

    # Verify the window title matches expected title (if available)
    if ($expectedTitle) {
        $windowTitle = [WinMgmt]::GetWindowTextString($largestHwnd)
        if ($windowTitle -notmatch [regex]::Escape($expectedTitle)) {
            # Title mismatch, try to find the correct window by enumerating all windows
            $allWindows = [WinMgmt]::FindVisibleWindowsByPid($TargetPid)
            foreach ($hwnd in $allWindows) {
                $title = [WinMgmt]::GetWindowTextString($hwnd)
                if ($title -match [regex]::Escape($expectedTitle)) {
                    $largestHwnd = $hwnd
                    break
                }
            }
        }
    }
}

$rectStr = [WinMgmt]::GetRectString($largestHwnd)

if ($Action -eq 'rect') {
    Write-Output $rectStr
} elseif ($Action -eq 'maximize') {
    # SW_RESTORE (9) then SW_MAXIMIZE (3)
    # Only SW_RESTORE if actually minimized — SW_RESTORE on a normal Chromium/Electron window
    # causes GPU rendering to freeze → black screen (QQ, 企业微信)
    if ([WinMgmt]::IsIconic($largestHwnd)) {
        [WinMgmt]::ShowWindow($largestHwnd, 9) | Out-Null
        Start-Sleep -Milliseconds 300
    }
    [WinMgmt]::ShowWindow($largestHwnd, 3) | Out-Null
    Start-Sleep -Milliseconds 500
    $rectAfter = [WinMgmt]::GetRectString($largestHwnd)
    Write-Output "ok hwnd=$largestHwnd before=$rectStr after=$rectAfter"
} elseif ($Action -eq 'restore') {
    # Only SW_RESTORE if actually minimized — SW_RESTORE on a normal Chromium/Electron window
    # causes GPU rendering to freeze → black screen (QQ, 企业微信)
    if ([WinMgmt]::IsIconic($largestHwnd)) {
        [WinMgmt]::ShowWindow($largestHwnd, 9) | Out-Null
        Start-Sleep -Milliseconds 500
    }
    $rectAfter = [WinMgmt]::GetRectString($largestHwnd)
    Write-Output "ok hwnd=$largestHwnd before=$rectStr after=$rectAfter"
} elseif ($Action -eq 'foreground') {
    $fgResult = [WinMgmt]::SetForegroundAggressive($largestHwnd)
    Write-Output "$fgResult hwnd=$largestHwnd"
}
