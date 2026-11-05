using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// SkyPost.cs - PostMessage-based input injection + reliable window activation.
//
// Why this exists (verified against WeChat 4.x / QQ NT / WeCom):
//  1. SendInput/keybd_event can be swallowed by apps installing low-level hooks
//     or running with UIPI/integrity differences. PostMessage delivers the input
//     directly to the target window's message queue, bypassing hooks entirely.
//  2. Popup/dropdown panels (e.g. WeChat search results) are SEPARATE top-level
//     windows (class Qt51514QWindowToolSaveBits). Clicking the main window at the
//     same coordinates does nothing - WindowFromPoint resolves the REAL window
//     under the target point so clicks land on the panel itself.
//  3. Qt-based apps frequently ignore plain SetForegroundWindow. The
//     AttachThreadInput trick + SW_RESTORE + BringWindowToTop reliably forces
//     them to the foreground.
//  4. Chinese input: posting WM_CHAR with GBK-encoded bytes lets the target
//     WndProc combine byte pairs into CJK characters (ANSI code page path),
//     which works even when the app rejects SendInput Unicode keystrokes.
public static class SkyPost
{
    [DllImport("user32.dll")] static extern IntPtr PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint WM_CHAR       = 0x0102;
    public const uint WM_KEYDOWN    = 0x0100;
    public const uint WM_KEYUP      = 0x0101;
    public const uint WM_MOUSEMOVE  = 0x0200;
    public const uint WM_LBUTTONDOWN= 0x0201;
    public const uint WM_LBUTTONUP  = 0x0202;
    public const uint WM_RBUTTONDOWN= 0x0204;
    public const uint WM_RBUTTONUP  = 0x0205;
    public const uint WM_MOUSEWHEEL = 0x020A;
    public const int  SW_RESTORE    = 9;

    static SkyPost() { try { SetProcessDPIAware(); } catch {} }

    // ===== Window resolution =====

    // Resolve the REAL window under a screen point (popup panels are separate windows).
    public static IntPtr WindowAt(int x, int y)
    {
        POINT p; p.X = x; p.Y = y;
        return WindowFromPoint(p);
    }

    public static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        return sb.ToString();
    }

    // Find the largest visible top-level window whose title contains the keyword
    // (case-insensitive). Returns IntPtr.Zero when not found.
    public static IntPtr FindByTitle(string keyword)
    {
        IntPtr found = IntPtr.Zero;
        long bestArea = 0;
        string kw = (keyword ?? "").ToLowerInvariant();
        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string t = sb.ToString();
            if (t.Length == 0) return true;
            if (t.ToLowerInvariant().IndexOf(kw) < 0) return true;
            RECT r;
            if (GetWindowRect(hWnd, out r))
            {
                long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
                if (area > bestArea) { bestArea = area; found = hWnd; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // ===== Window state =====

    // Current foreground window handle (IntPtr.Zero when none).
    public static IntPtr Foreground() { return GetForegroundWindow(); }

    // Current cursor position as "x,y" (physical pixels, DPI-aware).
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT lpPoint);
    public static string CursorPos()
    {
        POINT p;
        GetCursorPos(out p);
        return p.X + "," + p.Y;
    }

    // "exists=1,minimized=0,visible=1,fg=0,left,top,right,bottom"
    public static string StateOf(IntPtr h)
    {
        if (!IsWindow(h)) return "exists=0";
        bool min = IsIconic(h);
        bool vis = IsWindowVisible(h);
        bool fg = (GetForegroundWindow() == h);
        RECT r; GetWindowRect(h, out r);
        return "exists=1,minimized=" + (min ? 1 : 0) + ",visible=" + (vis ? 1 : 0) + ",fg=" + (fg ? 1 : 0)
             + "," + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
    }

    // ===== Activation =====

    // Force window to foreground using the AttachThreadInput trick.
    // Handles minimized (SW_RESTORE) and background Qt windows reliably.
    public static void ForceForeground(IntPtr hWnd)
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == hWnd) { ShowWindow(hWnd, SW_RESTORE); BringWindowToTop(hWnd); return; }
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(fg, out dummy);
        uint curThread = GetCurrentThreadId();
        uint tgtThread = GetWindowThreadProcessId(hWnd, out dummy);
        AttachThreadInput(curThread, fgThread, true);
        AttachThreadInput(curThread, tgtThread, true);
        ShowWindow(hWnd, SW_RESTORE);
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);
        AttachThreadInput(curThread, fgThread, false);
        AttachThreadInput(curThread, tgtThread, false);
        Thread.Sleep(150);
    }

    // ===== PostMessage input =====

    // Post a click to a specific window at screen coordinates.
    // Converts to client coordinates internally.
    public static void PostClickTo(IntPtr h, int screenX, int screenY, string button)
    {
        POINT p; p.X = screenX; p.Y = screenY;
        ScreenToClient(h, ref p);
        IntPtr lp = new IntPtr((p.Y << 16) | (p.X & 0xFFFF));
        PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
        Thread.Sleep(60);
        if (button == "right")
        {
            PostMessage(h, WM_RBUTTONDOWN, new IntPtr(2), lp);
            Thread.Sleep(80);
            PostMessage(h, WM_RBUTTONUP, IntPtr.Zero, lp);
        }
        else
        {
            PostMessage(h, WM_LBUTTONDOWN, new IntPtr(1), lp);
            Thread.Sleep(80);
            PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, lp);
        }
    }

    // Probe the real window under (x,y) - falling back to fallbackHwnd - then click it.
    // Returns the hwnd that received the click (hex) for logging.
    public static string PostClickAt(int x, int y, long fallbackHwnd, string button)
    {
        IntPtr target = WindowAt(x, y);
        if (target == IntPtr.Zero) target = new IntPtr(fallbackHwnd);
        if (target == IntPtr.Zero) return "target=0";
        PostClickTo(target, x, y, button);
        return "target=0x" + target.ToInt64().ToString("X") + ",class=" + ClassOf(target);
    }

    // Post key down+up (VK code) to a window. lParam=1 mimics a real first key-down.
    public static void PostKey(IntPtr h, uint vk)
    {
        PostMessage(h, WM_KEYDOWN, new IntPtr((long)vk), new IntPtr(1));
        Thread.Sleep(50);
        PostMessage(h, WM_KEYUP, new IntPtr((long)vk), new IntPtr(1));
        Thread.Sleep(50);
    }

    // Post a key combination (Ctrl/Alt/Shift + key) to a window via WM_KEYDOWN/UP.
    // Mirrors SkyInput.KeyCombo for hook-filtering apps (WeChat/QQ/WeCom).
    public static void PostCombo(IntPtr h, uint vk, bool ctrl, bool alt, bool shift)
    {
        const uint VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;
        if (ctrl)  PostMessage(h, WM_KEYDOWN, new IntPtr(VK_CONTROL), new IntPtr(1));
        if (alt)   PostMessage(h, WM_KEYDOWN, new IntPtr(VK_MENU), new IntPtr(1));
        if (shift) PostMessage(h, WM_KEYDOWN, new IntPtr(VK_SHIFT), new IntPtr(1));
        Thread.Sleep(40);
        PostMessage(h, WM_KEYDOWN, new IntPtr((long)vk), new IntPtr(1));
        Thread.Sleep(50);
        PostMessage(h, WM_KEYUP, new IntPtr((long)vk), new IntPtr(1));
        Thread.Sleep(30);
        if (shift) PostMessage(h, WM_KEYUP, new IntPtr(VK_SHIFT), new IntPtr(1));
        if (alt)   PostMessage(h, WM_KEYUP, new IntPtr(VK_MENU), new IntPtr(1));
        if (ctrl)  PostMessage(h, WM_KEYUP, new IntPtr(VK_CONTROL), new IntPtr(1));
        Thread.Sleep(30);
    }

    // Type text by posting WM_CHAR. Non-ASCII text is encoded as GBK (code page 936)
    // and posted byte-by-byte: the target WndProc reassembles byte pairs into CJK
    // characters through the ANSI path. ASCII bytes post directly.
    public static void PostTextGbk(IntPtr h, string text, int delayMs)
    {
        Encoding gbk = Encoding.GetEncoding(936);
        byte[] bytes = gbk.GetBytes(text ?? "");
        foreach (byte b in bytes)
        {
            PostMessage(h, WM_CHAR, new IntPtr((long)b), IntPtr.Zero);
            Thread.Sleep(delayMs > 0 ? delayMs : 100);
        }
    }

    // Type text posting Unicode WM_CHAR code points (for apps that handle WM_CHAR
    // as UTF-16, e.g. standard EDIT controls). Kept separate from the GBK path.
    public static void PostTextUnicode(IntPtr h, string text, int delayMs)
    {
        foreach (char c in (text ?? ""))
        {
            PostMessage(h, WM_CHAR, new IntPtr((int)c), IntPtr.Zero);
            Thread.Sleep(delayMs > 0 ? delayMs : 30);
        }
    }

    // Post a mouse-wheel event to a window without stealing focus.
    // WM_MOUSEWHEEL: wParam high-order word = wheel delta (positive = up),
    // low-order word = MK flags; lParam = screen coordinates of the pointer.
    public static void PostWheel(IntPtr h, int delta, int screenX, int screenY)
    {
        IntPtr wp = new IntPtr(((uint)delta << 16) & 0xFFFF0000);
        IntPtr lp = new IntPtr(((screenY & 0xFFFF) << 16) | (screenX & 0xFFFF));
        PostMessage(h, WM_MOUSEWHEEL, wp, lp);
    }

    // Post a double-click (two click pairs with the small gap real double clicks have).
    public static void PostDoubleClickTo(IntPtr h, int screenX, int screenY, string button)
    {
        PostClickTo(h, screenX, screenY, button);
        Thread.Sleep(120);
        PostClickTo(h, screenX, screenY, button);
    }

    // Window center as "x,y" (physical pixels) - for background clicks without explicit coordinates.
    // Returns "" when the window is gone; clamps to the visible screen area when the window is minimized.
    public static string CenterOf(IntPtr h)
    {
        RECT r;
        if (!IsWindow(h) || !GetWindowRect(h, out r)) return "";
        int cx = (r.Left + r.Right) / 2;
        int cy = (r.Top + r.Bottom) / 2;
        if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0 || r.Left < -9999 || r.Top < -9999) return "";
        return cx + "," + cy;
    }
}
