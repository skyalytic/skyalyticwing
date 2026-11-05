using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinMgmt {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // Ensure process is DPI-aware so GetWindowRect returns physical coordinates
    // Otherwise on DPI-scaled displays (150%, 200%), coordinates would be logical (halved)
    // and would not match Screen.capture which uses physical coordinates
    private static bool _dpiAwareSet = false;
    public static void EnsureDpiAware() {
        if (!_dpiAwareSet) {
            try { SetProcessDPIAware(); } catch {}
            _dpiAwareSet = true;
        }
    }

    public static List<IntPtr> FindVisibleWindowsByPid(int pid) {
        EnsureDpiAware();
        var result = new List<IntPtr>();
        // Get the main window handle of the process
        IntPtr mainWindowHandle = IntPtr.Zero;
        try {
            var process = System.Diagnostics.Process.GetProcessById(pid);
            mainWindowHandle = process.MainWindowHandle;
        } catch {
            // If we can't get the process, fall back to the old method
        }
        
        // If we have a main window handle, return it directly
        if (mainWindowHandle != IntPtr.Zero) {
            if (IsWindowVisible(mainWindowHandle)) {
                result.Add(mainWindowHandle);
                return result;
            }
        }
        
        // Otherwise, enumerate all windows and match by process ID
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                uint p = 0;
                GetWindowThreadProcessId(hWnd, out p);
                if ((int)p == pid) {
                    result.Add(hWnd);
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // Find largest visible window for given PID
    // Filter out windows with area < 100x100 (hidden helper windows, tray icons, etc.)
    public static IntPtr FindLargestVisibleWindow(int pid) {
        EnsureDpiAware();
        IntPtr largest = IntPtr.Zero;
        int largestArea = 0;
        var windows = FindVisibleWindowsByPid(pid);
        foreach (var hWnd in windows) {
            RECT r;
            if (GetWindowRect(hWnd, out r)) {
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w > 0 && h > 0 && w * h >= 10000) {
                    int area = w * h;
                    if (area > largestArea) {
                        largestArea = area;
                        largest = hWnd;
                    }
                }
            }
        }
        return largest;
    }

    public static string GetRectString(IntPtr hWnd) {
        EnsureDpiAware();
        RECT r;
        if (GetWindowRect(hWnd, out r)) {
            return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
        }
        return "0,0,0,0";
    }

    public static int GetWindowArea(IntPtr hWnd) {
        EnsureDpiAware();
        RECT r;
        if (GetWindowRect(hWnd, out r)) {
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w > 0 && h > 0) return w * h;
        }
        return 0;
    }

    // Wrapper method to get window title as string
    public static string GetWindowTextString(IntPtr hWnd) {
        EnsureDpiAware();
        var sb = new StringBuilder(256);
        GetWindowText(hWnd, sb, 256);
        return sb.ToString();
    }

    // Find largest visible top-level window whose title contains the given substring.
    // Sightflow-style: match window by title (matchWechatType), not by PID.
    // This is reliable for multi-process apps (WXWork/Weixin have many PIDs, only one owns the real window).
    // Filters: visible, non-empty title, area >= 100x100.
    // Minimized (iconic) windows are kept as fallback: their rect is -32000 so they cannot
    // win the area contest, but if no non-minimized window matches, the iconic handle is
    // returned so the caller can SW_RESTORE it (SetForegroundAggressive already does that).
    public static IntPtr FindLargestWindowByTitle(string titleSubstring) {
        EnsureDpiAware();
        IntPtr largest = IntPtr.Zero;
        int largestArea = 0;
        IntPtr iconicFallback = IntPtr.Zero;
        string needle = titleSubstring ?? "";
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (string.IsNullOrEmpty(title)) return true;
            if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
            if (IsIconic(hWnd)) {
                // minimized: remember as fallback, don't measure rect (would be -32000)
                if (iconicFallback == IntPtr.Zero) iconicFallback = hWnd;
                return true;
            }
            RECT r;
            if (GetWindowRect(hWnd, out r)) {
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w >= 100 && h >= 100) {
                    int area = w * h;
                    if (area > largestArea) {
                        largestArea = area;
                        largest = hWnd;
                    }
                }
            }
            return true;
        }, IntPtr.Zero);
        if (largest != IntPtr.Zero) return largest;
        return iconicFallback;
    }

    // Find a top-level window by PID + title substring, INCLUDING hidden windows.
    // Apps minimized to the system tray (e.g. WeChat 4.x) hide their main window instead
    // of minimizing it: IsWindowVisible=false, so visible-only lookups miss it.
    // EnumWindows enumerates hidden top-level windows, so we skip the visibility filter here.
    // Returns the largest-area matching hwnd (or first match if all areas are 0).
    public static IntPtr FindWindowByPidTitleIncludeHidden(int pid, string titleSubstring) {
        EnsureDpiAware();
        IntPtr best = IntPtr.Zero;
        int bestArea = -1;
        string needle = titleSubstring ?? "";
        EnumWindows((hWnd, lParam) => {
            uint wpid = 0;
            GetWindowThreadProcessId(hWnd, out wpid);
            if ((int)wpid != pid) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (string.IsNullOrEmpty(title)) return true;
            if (needle.Length > 0 && title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
            int area = GetWindowArea(hWnd);
            // Prefer the window matching the title with the largest area; hidden windows may
            // report area 0, so fall back to the first title match when no area wins.
            if (area > bestArea || best == IntPtr.Zero) {
                bestArea = area;
                best = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // Aggressively bring window to foreground.
    // IMPORTANT: Alt key trick (keybd_event 0x12) was REMOVED because it causes
    // Chromium/Electron apps (QQ, 企业微信) to freeze GPU rendering → black screen.
    // ShowWindow(SW_RESTORE) is only called when the window is actually minimized (IsIconic),
    // because calling SW_RESTORE on an already-normal window can trigger rendering context
    // rebuild in Chromium → also black screen.
    // Returns "ok" if the window is now in the foreground, "fail:*" otherwise.
    public static string SetForegroundAggressive(IntPtr hWnd) {
        EnsureDpiAware();
        if (hWnd == IntPtr.Zero) return "fail:no_hwnd";
        // Step 1: only restore if actually minimized (SW_RESTORE on non-minimized Chromium windows causes black screen)
        if (IsIconic(hWnd)) {
            ShowWindow(hWnd, 9); // SW_RESTORE
            System.Threading.Thread.Sleep(200);
        }
        // Step 2: already foreground?
        uint targetPid = 0;
        GetWindowThreadProcessId(hWnd, out targetPid);
        IntPtr fgBefore = GetForegroundWindow();
        if (fgBefore == hWnd) return "ok:already";
        // Step 3: BringWindowToTop + SetForegroundWindow (NO Alt key trick — it breaks Chromium GPU rendering)
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);
        System.Threading.Thread.Sleep(300);
        IntPtr fgNow = GetForegroundWindow();
        if (fgNow == hWnd) return "ok";
        // Step 4: AttachThreadInput workaround as last resort
        uint fgThread = GetWindowThreadProcessId(fgNow, out targetPid);
        uint myThread = GetCurrentThreadId();
        AttachThreadInput(myThread, fgThread, true);
        SetForegroundWindow(hWnd);
        AttachThreadInput(myThread, fgThread, false);
        System.Threading.Thread.Sleep(300);
        IntPtr fgAfter = GetForegroundWindow();
        if (fgAfter == hWnd) return "ok:attach";
        return "fail:foreground_rejected";
    }

    // List all visible windows info for a PID (for debugging)
    // Format: hwnd|className|title|left,top,right,bottom|width x height|visible|iconic|zoomed
    public static List<string> ListWindowsInfo(int pid) {
        EnsureDpiAware();
        var result = new List<string>();
        var windows = FindVisibleWindowsByPid(pid);
        foreach (var hWnd in windows) {
            RECT r;
            GetWindowRect(hWnd, out r);
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            var title = new StringBuilder(256);
            GetWindowText(hWnd, title, 256);
            bool visible = IsWindowVisible(hWnd);
            bool iconic = IsIconic(hWnd);
            bool zoomed = IsZoomed(hWnd);
            result.Add(hWnd + "|" + cls.ToString() + "|" + title.ToString() + "|" +
                       r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "|" +
                       w + "x" + h + "|visible=" + visible + "|iconic=" + iconic + "|zoomed=" + zoomed);
        }
        return result;
    }
}
