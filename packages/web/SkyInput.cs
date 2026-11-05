using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

// SendInput-based input injection.
// Replaces legacy mouse_event/keybd_event: modern apps (WeChat/WeCom/QQ/Lark)
// filter those old APIs but accept SendInput, which is what robotjs/AutoHotkey use.
public static class SkyInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]
  static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  static extern uint MapVirtualKey(uint uCode, uint uMapType);
  [DllImport("user32.dll")]
  static extern bool SetProcessDPIAware();

  // Ensure physical-pixel coordinates: without this, on DPI-scaled displays
  // Windows virtualizes SetCursorPos/SendInput coordinates and clicks land off-target.
  static SkyInput() { try { SetProcessDPIAware(); } catch {} }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;

  static readonly Random _rng = new Random();

  static INPUT KeyInput(ushort vk, uint flags) {
    INPUT i = new INPUT(); i.type = INPUT_KEYBOARD;
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)(MapVirtualKey(vk, 0) & 0xFF), dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
  }
  static INPUT UnicodeInput(char c, uint flags) {
    INPUT i = new INPUT(); i.type = INPUT_KEYBOARD;
    i.u.ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)c, dwFlags = KEYEVENTF_UNICODE | flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
  }
  static INPUT MouseInput(uint flags, int data) {
    INPUT i = new INPUT(); i.type = INPUT_MOUSE;
    i.u.mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
  }
  static uint Send(INPUT[] arr) { return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))); }

  public static void Click(int x, int y, string button) {
    SetCursorPos(x, y);
    Thread.Sleep(80);
    ClickHere(button);
  }

  public static void ClickHere(string button) {
    uint down, up;
    if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
    else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
    else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
    Send(new INPUT[] { MouseInput(down, 0) });
    Thread.Sleep(50 + _rng.Next(0, 40)); // human-like press duration
    Send(new INPUT[] { MouseInput(up, 0) });
  }

  public static void KeyCombo(ushort vk, bool ctrl, bool alt, bool shift) {
    var list = new List<INPUT>();
    if (ctrl) list.Add(KeyInput(0xA2, 0));
    if (alt) list.Add(KeyInput(0xA4, 0));
    if (shift) list.Add(KeyInput(0xA0, 0));
    list.Add(KeyInput(vk, 0));
    list.Add(KeyInput(vk, KEYEVENTF_KEYUP));
    if (shift) list.Add(KeyInput(0xA0, KEYEVENTF_KEYUP));
    if (alt) list.Add(KeyInput(0xA4, KEYEVENTF_KEYUP));
    if (ctrl) list.Add(KeyInput(0xA2, KEYEVENTF_KEYUP));
    Send(list.ToArray());
  }

  // Type any Unicode text directly (bypasses clipboard and IME)
  public static void TypeUnicode(string text, int delayMs) {
    foreach (char c in text) {
      Send(new INPUT[] { UnicodeInput(c, 0), UnicodeInput(c, KEYEVENTF_KEYUP) });
      if (delayMs > 0) Thread.Sleep(delayMs);
    }
  }

  public static void Paste() { KeyCombo(0x56, true, false, false); }

  public static void Scroll(int delta) {
    Send(new INPUT[] { MouseInput(MOUSEEVENTF_WHEEL, delta) });
  }

  public static void Drag(int fx, int fy, int tx, int ty, int ms) {
    SetCursorPos(fx, fy);
    Thread.Sleep(100);
    Send(new INPUT[] { MouseInput(MOUSEEVENTF_LEFTDOWN, 0) });
    int steps = Math.Max(ms / 10, 1);
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(fx + (tx - fx) * i / steps, fy + (ty - fy) * i / steps);
      Thread.Sleep(10);
    }
    Send(new INPUT[] { MouseInput(MOUSEEVENTF_LEFTUP, 0) });
  }
}
