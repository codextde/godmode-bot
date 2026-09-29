/**
 * Windows desktop helper: a PowerShell process hosting a small C# class (compiled by Add-Type from the .NET
 * Framework that ships with Windows) that speaks the same JSON-lines protocol as the macOS helper — every monitor
 * (EnumDisplayMonitors), screenshots (CopyFromScreen), and global mouse/keyboard input (SendInput). Coordinates are
 * physical pixels of the virtual desktop (the process is DPI aware). Windows of single apps are Cua Driver's job.
 */

export const WINDOWS_HELPER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class GodmodeComputer {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

  class Monitor { public string Id; public Rectangle Bounds; public bool Primary; }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40, WHEEL = 0x800, HWHEEL = 0x1000;
  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;

  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort> {
    {"enter", 0x0D}, {"kpenter", 0x0D}, {"tab", 0x09}, {"space", 0x20}, {"backspace", 0x08}, {"delete", 0x2E},
    {"escape", 0x1B}, {"left", 0x25}, {"up", 0x26}, {"right", 0x27}, {"down", 0x28}, {"home", 0x24}, {"end", 0x23},
    {"pageup", 0x21}, {"pagedown", 0x22}, {"insert", 0x2D}, {"capslock", 0x14}, {"volumeup", 0xAF},
    {"volumedown", 0xAE}, {"mute", 0xAD},
    {"cmd", 0x5B}, {"ctrl", 0x11}, {"alt", 0x12}, {"shift", 0x10},
  };
  static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B };

  public static void Init() {
    // Per-monitor DPI awareness, so bounds, captures and input all use physical pixels.
    int hr = -1;
    try { hr = SetProcessDpiAwareness(2); } catch {}
    if (hr != 0) { try { SetProcessDPIAware(); } catch {} }
    for (int i = 1; i <= 24; i++) Named["f" + i] = (ushort)(0x6F + i);
  }

  public static string Handle(string line) {
    object id = null;
    try {
      var req = Json.Deserialize<Dictionary<string, object>>(line);
      req.TryGetValue("id", out id);
      object cmd;
      req.TryGetValue("cmd", out cmd);
      object result = Dispatch(Convert.ToString(cmd), req);
      return Json.Serialize(new Dictionary<string, object> { {"id", id}, {"ok", true}, {"result", result} });
    } catch (HelperException e) {
      return Json.Serialize(new Dictionary<string, object> { {"id", id}, {"ok", false}, {"error", e.Message}, {"code", e.Code} });
    } catch (Exception e) {
      return Json.Serialize(new Dictionary<string, object> { {"id", id}, {"ok", false}, {"error", e.Message}, {"code", "failed"} });
    }
  }

  class HelperException : Exception { public string Code; public HelperException(string m, string c) : base(m) { Code = c; } }

  static double Num(Dictionary<string, object> p, string k, double fallback) {
    object v; return p.TryGetValue(k, out v) && v != null ? Convert.ToDouble(v) : fallback;
  }
  static double Req(Dictionary<string, object> p, string k) {
    object v; if (!p.TryGetValue(k, out v) || v == null) throw new HelperException("Missing number \"" + k + "\"", "bad_request");
    return Convert.ToDouble(v);
  }
  static string Str(Dictionary<string, object> p, string k) { object v; return p.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null; }
  static List<string> Strs(Dictionary<string, object> p, string k) {
    var list = new List<string>(); object v;
    if (p.TryGetValue(k, out v) && v is System.Collections.IEnumerable && !(v is string)) foreach (var x in (System.Collections.IEnumerable)v) list.Add(Convert.ToString(x));
    return list;
  }

  static object Dispatch(string cmd, Dictionary<string, object> p) {
    switch (cmd) {
      case "hello": return new Dictionary<string, object> { {"version", "1"}, {"os", Environment.OSVersion.VersionString} };
      case "permissions": return new Dictionary<string, object> { {"accessibility", true}, {"screenRecording", true} };
      case "displays": return Displays();
      case "cursor": { POINT pt; GetCursorPos(out pt); return new Dictionary<string, object> { {"x", pt.X}, {"y", pt.Y} }; }
      case "capture": return Capture(p);
      case "pointer": return Pointer(p);
      case "key": Key(p); return new Dictionary<string, object> { {"ok", true} };
      case "type": TypeText(Str(p, "text") ?? ""); return new Dictionary<string, object> { {"ok", true} };
      case "openApp": {
        var name = (Str(p, "name") ?? "").Trim();
        // App names only (resolved through App Paths / PATH) — no paths, URLs or protocol handlers.
        if (name.Length == 0 || name.Length > 100 || name.IndexOfAny(new[] { ':', '/', '\\', '"', '%', '<', '>', '|' }) >= 0) {
          throw new HelperException("Pass an app name, e.g. \"notepad\" or \"chrome\".", "bad_request");
        }
        var proc = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(name) { UseShellExecute = true });
        return new Dictionary<string, object> { {"pid", proc != null ? (object)proc.Id : null}, {"path", name} };
      }
      default: throw new HelperException("Unsupported command \"" + cmd + "\" on Windows", cmd == "windows" || cmd == "window" || cmd == "activate" ? "unsupported" : "bad_request");
    }
  }

  /** Asked fresh every time (Screen.AllScreens caches until a window message this thread never pumps). */
  static List<Monitor> Monitors() {
    var list = new List<Monitor>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr h, IntPtr hdc, ref RECT r, IntPtr d) {
      var info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (GetMonitorInfo(h, ref info)) {
        var b = info.rcMonitor;
        list.Add(new Monitor { Id = info.szDevice, Bounds = new Rectangle(b.Left, b.Top, b.Right - b.Left, b.Bottom - b.Top), Primary = (info.dwFlags & 1) != 0 });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static List<object> Displays() {
    var list = new List<object>();
    foreach (var m in Monitors()) {
      list.Add(new Dictionary<string, object> {
        {"id", m.Id}, {"name", m.Primary ? "Primary display" : m.Id.Replace("\\\\.\\", "")},
        {"x", m.Bounds.X}, {"y", m.Bounds.Y}, {"width", m.Bounds.Width}, {"height", m.Bounds.Height},
        {"scale", 1}, {"primary", m.Primary},
      });
    }
    return list;
  }

  static Monitor MonitorById(string id) {
    foreach (var m in Monitors()) if (m.Id == id || (id == "primary" && m.Primary)) return m;
    return null;
  }

  static object Capture(Dictionary<string, object> p) {
    if (Str(p, "window") != null) throw new HelperException("Window capture on Windows goes through Cua Driver", "unsupported");
    var id = Str(p, "display") ?? "primary";
    var screen = MonitorById(id);
    if (screen == null) throw new HelperException("Display " + id + " is not connected.", "display_gone");
    var area = screen.Bounds;
    if (p.ContainsKey("rx")) {
      var region = new Rectangle((int)Req(p, "rx"), (int)Req(p, "ry"), Math.Max(1, (int)Req(p, "rw")), Math.Max(1, (int)Req(p, "rh")));
      area = Rectangle.Intersect(area, region);
      if (area.Width < 1 || area.Height < 1) throw new HelperException("The zoom region is outside the shared area.", "bad_request");
    }
    double maxW = Num(p, "maxWidth", 1456), maxH = Num(p, "maxHeight", 1456);
    double scale = Math.Min(1.0, Math.Min(maxW / area.Width, maxH / area.Height));
    int ow = Math.Max(1, (int)Math.Round(area.Width * scale)), oh = Math.Max(1, (int)Math.Round(area.Height * scale));
    using (var full = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb))
    using (var out_ = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(area.X, area.Y, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
      using (var g = Graphics.FromImage(out_)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(full, 0, 0, ow, oh);
      }
      var format = Str(p, "format") == "png" ? "png" : "jpeg";
      using (var ms = new MemoryStream()) {
        if (format == "png") out_.Save(ms, ImageFormat.Png);
        else {
          var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Jpeg.Guid);
          var ep = new EncoderParameters(1);
          ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Round(Num(p, "quality", 0.75) * 100));
          out_.Save(ms, codec, ep);
        }
        return new Dictionary<string, object> {
          {"data", Convert.ToBase64String(ms.ToArray())}, {"format", format}, {"width", ow}, {"height", oh},
          {"x", area.X}, {"y", area.Y}, {"pointWidth", area.Width}, {"pointHeight", area.Height},
        };
      }
    }
  }

  static INPUT Mouse(uint flags, uint data) {
    var i = new INPUT { type = INPUT_MOUSE };
    i.U.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
    return i;
  }

  static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.U.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    return i;
  }

  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) {
      throw new HelperException("Windows refused the input (a window of a higher-privileged app may be in front).", "failed");
    }
  }

  static void Mods(List<string> mods, bool down) {
    var order = down ? mods : new List<string>(mods);
    if (!down) order.Reverse();
    foreach (var m in order) {
      ushort vk;
      if (!Named.TryGetValue(m, out vk)) throw new HelperException("Unknown modifier \"" + m + "\"", "bad_request");
      Send(KeyInput(vk, 0, (down ? 0u : KEYUP) | (Extended.Contains(vk) ? EXTENDED : 0u)));
    }
  }

  static object Pointer(Dictionary<string, object> p) {
    if (Str(p, "pid") != null) throw new HelperException("Background input on Windows goes through Cua Driver", "unsupported");
    var action = Str(p, "action") ?? "click";
    int x = (int)Math.Round(Req(p, "x")), y = (int)Math.Round(Req(p, "y"));
    var button = Str(p, "button") ?? "left";
    uint down = button == "right" ? RIGHTDOWN : button == "middle" ? MIDDLEDOWN : LEFTDOWN;
    uint up = button == "right" ? RIGHTUP : button == "middle" ? MIDDLEUP : LEFTUP;
    var mods = Strs(p, "modifiers");
    SetCursorPos(x, y);
    Thread.Sleep(20);
    switch (action) {
      case "move": break;
      case "down": Send(Mouse(down, 0)); break;
      case "up": Send(Mouse(up, 0)); break;
      case "click": {
        int count = Math.Max(1, Math.Min(3, (int)Num(p, "count", 1)));
        Mods(mods, true);
        try {
          for (int i = 0; i < count; i++) { Send(Mouse(down, 0), Mouse(up, 0)); if (i < count - 1) Thread.Sleep(60); }
        } finally { Mods(mods, false); }
        break;
      }
      case "drag": {
        int tx = (int)Math.Round(Req(p, "toX")), ty = (int)Math.Round(Req(p, "toY"));
        Mods(mods, true);
        try {
          Send(Mouse(down, 0));
          for (int i = 1; i <= 12; i++) { SetCursorPos(x + (tx - x) * i / 12, y + (ty - y) * i / 12); Thread.Sleep(16); }
          Send(Mouse(up, 0));
        } finally { Mods(mods, false); }
        break;
      }
      case "scroll": {
        double dy = Num(p, "dy", 0), dx = Num(p, "dx", 0);
        // 120 per wheel notch; positive dy scrolls content down (wheel toward the user = negative delta).
        if (dy != 0) Send(Mouse(WHEEL, unchecked((uint)(int)Math.Round(-dy * 2))));
        if (dx != 0) Send(Mouse(HWHEEL, unchecked((uint)(int)Math.Round(dx * 2))));
        break;
      }
      default: throw new HelperException("Unknown pointer action \"" + action + "\"", "bad_request");
    }
    return new Dictionary<string, object> { {"method", "event"} };
  }

  static void Key(Dictionary<string, object> p) {
    if (Str(p, "pid") != null) throw new HelperException("Background input on Windows goes through Cua Driver", "unsupported");
    var key = (Str(p, "key") ?? "");
    var action = Str(p, "action") ?? "press";
    var mods = Strs(p, "modifiers");
    ushort vk;
    bool shift = false;
    if (!Named.TryGetValue(key.ToLowerInvariant(), out vk)) {
      if (key.Length != 1) throw new HelperException("Unknown key \"" + key + "\"", "bad_request");
      short scan = VkKeyScan(key[0]);
      // Not on this layout, or only reachable with Ctrl/Alt (AltGr on e.g. German keyboards): type the character.
      if (scan == -1 || (scan & 0x600) != 0) {
        if (mods.Count == 0) { TypeText(key); return; }
        throw new HelperException("The key \"" + key + "\" can't be combined with modifiers on this keyboard layout", "bad_request");
      }
      vk = (ushort)(scan & 0xff);
      shift = (scan & 0x100) != 0 && !mods.Contains("shift") && mods.Count == 0;
    }
    if (shift) mods.Add("shift");
    uint ext = Extended.Contains(vk) ? EXTENDED : 0u;
    if (action != "up") { Mods(mods, true); Send(KeyInput(vk, 0, ext)); }
    if (action == "press") Thread.Sleep(12);
    if (action != "down") { Send(KeyInput(vk, 0, ext | KEYUP)); Mods(mods, false); }
  }

  static void TypeText(string text) {
    foreach (char c in text) {
      if (c == '\n' || c == '\r') { Send(KeyInput(0x0D, 0, 0), KeyInput(0x0D, 0, KEYUP)); }
      else Send(KeyInput(0, c, UNICODE), KeyInput(0, c, UNICODE | KEYUP));
      Thread.Sleep(4);
    }
  }
}
`;

/** PowerShell host: compiles the class, then answers one JSON request per stdin line. */
export const WINDOWS_HELPER_PS1 = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'godmode-computer.cs')
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing, System.Windows.Forms, System.Web.Extensions
[GodmodeComputer]::Init()
[Console]::Out.WriteLine('{"ready":true,"version":"1"}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  [Console]::Out.WriteLine([GodmodeComputer]::Handle($line))
  [Console]::Out.Flush()
}
`;
