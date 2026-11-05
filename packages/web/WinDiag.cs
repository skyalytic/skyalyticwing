using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinDiag {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    private static bool _dpiAwareSet = false;
    public static void EnsureDpiAware() {
        if (!_dpiAwareSet) {
            try { SetProcessDPIAware(); } catch {}
            _dpiAwareSet = true;
        }
    }

    public static List<string> ListAllVisibleWindows() {
        EnsureDpiAware();
        var result = new List<string>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            RECT r;
            GetWindowRect(hWnd, out r);
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w < 50 || h < 50) return true; // skip tiny windows
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            var title = new StringBuilder(256);
            GetWindowText(hWnd, title, 256);
            bool iconic = IsIconic(hWnd);
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            result.Add(hWnd + "|pid=" + pid + "|cls=" + cls.ToString() + "|title=[" + title.ToString() + "]|" +
                       r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "|" + w + "x" + h + "|iconic=" + iconic);
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
