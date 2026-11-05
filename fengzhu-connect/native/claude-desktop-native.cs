// Build with ops/build-claude-desktop-native.ps1. Runtime scripts load the
// resulting assembly; they must not start the .NET Framework C# compiler.
// Windows PowerShell's runtime compilation failed with Win32 error 1314 in
// the installed connector on 2026-10-18, before any desktop action ran.
using System;
using System.Runtime.InteropServices;

public static class KhClaudeNative
{
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
