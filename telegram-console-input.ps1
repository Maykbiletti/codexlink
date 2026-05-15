param(
  [Parameter(Mandatory = $true)]
  [int]$TargetPid,

  [string]$Text = "",

  [switch]$ClearBefore,

  [switch]$Submit
)

$ErrorActionPreference = "Stop"

$typeName = "ConsoleInputWriter"
$assemblyDir = Join-Path $env:TEMP "blun-codexlink"
$assemblyPath = Join-Path $assemblyDir "console-input-writer-v4.dll"

$source = @"
using System;
using System.Runtime.InteropServices;

public static class ConsoleInputWriter {
  private const int STD_INPUT_HANDLE = -10;
  private const short KEY_EVENT = 0x0001;
  private const ushort VK_RETURN = 0x0D;
  private const ushort VK_BACK = 0x08;
  private const ushort VK_U = 0x55;
  private const ushort SCAN_RETURN = 0x1C;
  private const ushort SCAN_U = 0x16;
  private const uint LEFT_CTRL_PRESSED = 0x0008;
  private const uint GENERIC_READ = 0x80000000;
  private const uint GENERIC_WRITE = 0x40000000;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint OPEN_EXISTING = 3;

  [StructLayout(LayoutKind.Sequential)]
  public struct KEY_EVENT_RECORD {
    [MarshalAs(UnmanagedType.Bool)]
    public bool bKeyDown;
    public ushort wRepeatCount;
    public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode;
    public char UnicodeChar;
    public uint dwControlKeyState;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)]
    public short EventType;
    [FieldOffset(4)]
    public KEY_EVENT_RECORD KeyEvent;
  }

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool AttachConsole(uint dwProcessId);

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool FreeConsole();

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr GetStdHandle(int nStdHandle);

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern bool WriteConsoleInputW(IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);

  public static void WriteText(int targetPid, string text, bool clearBefore, bool submit) {
    FreeConsole();
    if (!AttachConsole((uint)targetPid)) {
      throw new InvalidOperationException("AttachConsole failed: " + Marshal.GetLastWin32Error());
    }

    IntPtr input = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (input == IntPtr.Zero || input == new IntPtr(-1)) {
      input = GetStdHandle(STD_INPUT_HANDLE);
    }
    if (input == IntPtr.Zero || input == new IntPtr(-1)) {
      throw new InvalidOperationException("Open console input failed: " + Marshal.GetLastWin32Error());
    }

    try {
      if (clearBefore) {
        WriteKey(input, (char)21, VK_U, SCAN_U, LEFT_CTRL_PRESSED);
      }

      foreach (char ch in text) {
        WriteKey(input, ch, 0);
      }

      if (submit) {
        WriteKey(input, '\r', VK_RETURN, SCAN_RETURN);
      }
    } finally {
      CloseHandle(input);
      FreeConsole();
    }
  }

  private static void WriteKey(IntPtr input, char ch, ushort virtualKey) {
    WriteKey(input, ch, virtualKey, 0);
  }

  private static void WriteKey(IntPtr input, char ch, ushort virtualKey, ushort virtualScanCode) {
    WriteKey(input, ch, virtualKey, virtualScanCode, 0);
  }

  private static void WriteKey(IntPtr input, char ch, ushort virtualKey, ushort virtualScanCode, uint controlKeyState) {
    INPUT_RECORD[] records = new INPUT_RECORD[2];
    records[0].EventType = KEY_EVENT;
    records[0].KeyEvent.bKeyDown = true;
    records[0].KeyEvent.wRepeatCount = 1;
    records[0].KeyEvent.wVirtualKeyCode = virtualKey;
    records[0].KeyEvent.wVirtualScanCode = virtualScanCode;
    records[0].KeyEvent.UnicodeChar = ch;
    records[0].KeyEvent.dwControlKeyState = controlKeyState;

    records[1].EventType = KEY_EVENT;
    records[1].KeyEvent.bKeyDown = false;
    records[1].KeyEvent.wRepeatCount = 1;
    records[1].KeyEvent.wVirtualKeyCode = virtualKey;
    records[1].KeyEvent.wVirtualScanCode = virtualScanCode;
    records[1].KeyEvent.UnicodeChar = ch;
    records[1].KeyEvent.dwControlKeyState = controlKeyState;

    uint written;
    if (!WriteConsoleInputW(input, records, (uint)records.Length, out written) || written != records.Length) {
      throw new InvalidOperationException("WriteConsoleInputW failed: " + Marshal.GetLastWin32Error());
    }
  }
}
"@

if (-not ($typeName -as [type])) {
  if (Test-Path $assemblyPath) {
    Add-Type -Path $assemblyPath
  } else {
    New-Item -ItemType Directory -Path $assemblyDir -Force | Out-Null
    Add-Type -TypeDefinition $source -OutputAssembly $assemblyPath -OutputType Library
    Add-Type -Path $assemblyPath
  }
}

$normalizedText = $Text -replace "`r`n", " " -replace "`n", " " -replace "`r", " "
[ConsoleInputWriter]::WriteText($TargetPid, $normalizedText, [bool]$ClearBefore, [bool]$Submit)
