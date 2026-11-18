# One long-lived, hidden process. All power requests are made on the same
# thread, so ES_CONTINUOUS can be reliably cleared on exit or when disabled.
# No simulated input, lock-screen bypass, or permanent power-plan changes.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KhLinkScreenMonitor {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint SetThreadExecutionState(uint state);
  [DllImport("wtsapi32.dll", SetLastError = true)]
  static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")]
  static extern void WTSFreeMemory(IntPtr buffer);
  const uint Continuous = 0x80000000;
  const uint SystemRequired = 0x00000001;
  const uint DisplayRequired = 0x00000002;

  // WTSINFOEXW has a DWORD Level followed by an 8-byte-aligned union;
  // WTSINFOEX_LEVEL1 starts with SessionId, SessionState and SessionFlags.
  // Only read the flags, never the adjacent account/domain fields.
  static string Locked() {
    if (!Environment.Is64BitProcess) return "null";
    IntPtr buffer = IntPtr.Zero; int bytes = 0;
    try {
      if (!WTSQuerySessionInformationW(IntPtr.Zero, -1, 25, out buffer, out bytes) || buffer == IntPtr.Zero || bytes < 20) return "null";
      if (Marshal.ReadInt32(buffer, 0) != 1 || Marshal.ReadInt32(buffer, 12) != 0) return "null";
      int flags = Marshal.ReadInt32(buffer, 16);
      return flags == 0 ? "true" : flags == 1 ? "false" : "null";
    } catch { return "null"; }
    finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
  }

  public static void Run() {
    bool active = false, initialized = false; string line;
    try {
      while ((line = Console.ReadLine()) != null) {
        bool desired = line == "1";
        if (line != "0" && line != "1") continue;
        bool failed = false;
        if (!initialized || desired != active) {
          uint flags = Continuous | (desired ? (SystemRequired | DisplayRequired) : 0u);
          if (SetThreadExecutionState(flags) == 0) failed = true;
          else { active = desired; initialized = true; }
        }
        Console.WriteLine("{\"locked\":" + Locked() + ",\"wakeActive\":" + (failed ? "null" : active ? "true" : "false") + ",\"wakeError\":" + (failed ? "true" : "false") + "}");
        Console.Out.Flush();
      }
    } finally { if (initialized) SetThreadExecutionState(Continuous); }
  }
}
'@
[KhLinkScreenMonitor]::Run()
