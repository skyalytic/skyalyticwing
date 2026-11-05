param([int]$TargetPid)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$callback = [WinEnum+EnumWindowsProc]{
    param($hWnd, $lParam)
    $procId = 0
    [WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
    if ($procId -eq $TargetPid) {
        $visible = [WinEnum]::IsWindowVisible($hWnd)
        $rect = New-Object WinEnum+RECT
        [WinEnum]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
        $sb = New-Object System.Text.StringBuilder(256)
        [WinEnum]::GetWindowText($hWnd, $sb, 256) | Out-Null
        $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
        Write-Output ("hwnd=" + $hWnd.ToInt64() + " visible=" + $visible + " rect=" + $rect.Left + "," + $rect.Top + "," + $rect.Right + "," + $rect.Bottom + " area=" + $area + " title='" + $sb.ToString() + "'")
    }
    return $true
}

[WinEnum]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
