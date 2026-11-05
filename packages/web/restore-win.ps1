param([int64]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinShow {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public const int SW_RESTORE = 9;
    public const int SW_MAXIMIZE = 3;
    public const int SW_SHOW = 5;
}
"@

$h = [IntPtr]$Hwnd
$wasIconic = [WinShow]::IsIconic($h)
Write-Output ("Before: IsIconic=" + $wasIconic + " IsZoomed=" + [WinShow]::IsZoomed($h))

if ($wasIconic) {
    [WinShow]::ShowWindow($h, [WinShow]::SW_RESTORE) | Out-Null
    Write-Output "Restored from minimized"
    Start-Sleep -Milliseconds 800
}

[WinShow]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500

$rect = New-Object WinShow+RECT
[WinShow]::GetWindowRect($h, [ref]$rect) | Out-Null
$area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
Write-Output ("After: rect=" + $rect.Left + "," + $rect.Top + "," + $rect.Right + "," + $rect.Bottom + " area=" + $area)
