param(
  [Parameter(Mandatory = $true)]
  [string]$StateFile,

  [Parameter(Mandatory = $true)]
  [string]$BaseTitle,

  [string]$LogFile = ""
)

$ErrorActionPreference = "SilentlyContinue"

function Stop-EmbeddedQueueTitleWatcher {
  param([string]$TypeName)

  try {
    $type = $TypeName -as [type]
    if ($null -eq $type) { return }

    $flags = [System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Static
    $field = $type.GetField("_timer", $flags)
    if ($null -eq $field) { return }

    $timer = $field.GetValue($null)
    if ($null -ne $timer) {
      $timer.Dispose()
      $field.SetValue($null, $null)
    }
  } catch {}
}

Stop-EmbeddedQueueTitleWatcher -TypeName "BlunEmbeddedQueueTitleWatcher"
Stop-EmbeddedQueueTitleWatcher -TypeName "BlunEmbeddedQueueTitleWatcherQueueOnlyV2"

if (-not ("BlunEmbeddedQueueTitleWatcherQueueOnlyV2" -as [type])) {
  Add-Type -ReferencedAssemblies "System.Web.Extensions" -TypeDefinition @"
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;

public static class BlunEmbeddedQueueTitleWatcherQueueOnlyV2
{
    private static Timer _timer;
    private static string _stateFile;
    private static string _baseTitle;
    private static string _lastTitle = "";
    private static long _ambientTtlMs = 600000;
    private static string _lastNotice = "";
    private static string _lastUiNotice = "";
    private static string _lastUiKind = "";
    private static int _lastOverlayTop = -1;
    private static int _lastOverlayWidth = 0;
    private static string _logFile = "";
    private static readonly object Gate = new object();

    public static void Start(string stateFile, string baseTitle, long ambientTtlMs, string logFile)
    {
        lock (Gate)
        {
            _stateFile = stateFile ?? "";
            _baseTitle = baseTitle ?? "";
            _lastTitle = "";
            _ambientTtlMs = ambientTtlMs > 0 ? ambientTtlMs : 600000;
            _logFile = logFile ?? "";
            _lastNotice = "";
            _lastUiNotice = "";
            _lastUiKind = "";
            _lastOverlayTop = -1;
            _lastOverlayWidth = 0;
            WriteLog("START");
            TrySetTitle(_baseTitle);
            if (_timer != null)
            {
                _timer.Dispose();
            }
            _timer = new Timer(_ => Tick(), null, 0, 900);
        }
    }

    private static void Tick()
    {
        try
        {
            string title;
            string notice;
            string uiNotice;
            string uiKind;
            BuildSnapshot(out title, out notice, out uiNotice, out uiKind);
            TrySetTitle(title);
            TryWriteNotice(notice);
            TryWriteUiNotice(uiKind, uiNotice);
        }
        catch
        {
            WriteLog("TICK_ERROR");
        }
    }

    private static void TrySetTitle(string value)
    {
        var normalizedTitle = value ?? "";
        if (string.Equals(normalizedTitle, _lastTitle, StringComparison.Ordinal))
        {
            return;
        }
        try
        {
            Console.Title = normalizedTitle;
            _lastTitle = normalizedTitle;
            WriteLog("TITLE " + Normalize(normalizedTitle, 180));
        }
        catch
        {
            WriteLog("TITLE_ERROR");
        }
    }

    private static void TryWriteNotice(string notice)
    {
        var normalized = notice ?? "";
        if (string.Equals(normalized, _lastNotice, StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            // Do not write background queue notices into the interactive Codex
            // terminal. It corrupts the prompt/input area on Windows terminals.
        }
        catch
        {
            WriteLog("NOTICE_ERROR");
        }

        _lastNotice = normalized;
        WriteLog("NOTICE " + Normalize(normalized, 220));
    }

    private static void TryWriteUiNotice(string kind, string notice)
    {
        var normalizedKind = string.IsNullOrWhiteSpace(kind) ? "generic" : kind.Trim().ToLowerInvariant();
        var normalized = notice ?? "";
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return;
        }

        if (string.Equals(normalized, _lastUiNotice, StringComparison.Ordinal)
            && string.Equals(normalizedKind, _lastUiKind, StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            // Never write Telegram queue notices directly into the interactive
            // Codex terminal. The Codex TUI owns that screen; direct writes can
            // hide the composer and make Telegram messages look like plain
            // console text instead of real injected messages.
        }
        catch
        {
            WriteLog("UI_ERROR " + normalizedKind);
        }

        _lastUiNotice = normalized;
        _lastUiKind = normalizedKind;
        WriteLog("UI " + normalizedKind + " " + Normalize(normalized, 220));
    }

    private static void TryWriteAboveInput(string kind, string notice)
    {
        var prefix = string.Equals(kind, "outbound", StringComparison.OrdinalIgnoreCase)
            ? "Telegram Reply: "
            : "Telegram Queue: ";
        var width = 100;
        try
        {
            width = Math.Max(40, Console.WindowWidth);
        }
        catch
        {
            width = 100;
        }

        var line = Normalize(prefix + notice, Math.Max(20, width - 1));
        if (line.Length < width - 1)
        {
            line = line + new string(' ', Math.Max(0, width - 1 - line.Length));
        }

        var left = 0;
        var top = 0;
        try
        {
            left = Console.CursorLeft;
            top = Console.CursorTop;
        }
        catch
        {
            Console.WriteLine(prefix + notice);
            return;
        }

        try
        {
            var bufferHeight = Math.Max(1, Console.BufferHeight);
            var bufferWidth = Math.Max(1, Console.BufferWidth);
            var windowTop = Math.Max(0, Console.WindowTop);
            var windowHeight = Math.Max(1, Console.WindowHeight);
            var bottomOffset = GetOverlayBottomOffset();
            var targetTop = windowTop + Math.Max(0, windowHeight - bottomOffset);
            targetTop = Math.Min(Math.Max(windowTop, targetTop), Math.Max(0, bufferHeight - 1));
            var targetWidth = Math.Max(1, width - 1);

            if (_lastOverlayTop >= 0 && _lastOverlayTop < bufferHeight)
            {
                Console.SetCursorPosition(0, _lastOverlayTop);
                Console.Write(new string(' ', Math.Max(0, _lastOverlayWidth)));
            }

            Console.SetCursorPosition(0, targetTop);
            var previousForeground = Console.ForegroundColor;
            try
            {
                Console.ForegroundColor = ConsoleColor.DarkCyan;
                Console.Write(line.Substring(0, Math.Min(line.Length, targetWidth)));
            }
            finally
            {
                Console.ForegroundColor = previousForeground;
            }
            _lastOverlayTop = targetTop;
            _lastOverlayWidth = targetWidth;

            var restoreTop = Math.Min(Math.Max(0, top), Math.Max(0, bufferHeight - 1));
            var restoreLeft = Math.Min(Math.Max(0, left), Math.Max(0, width - 1));
            Console.SetCursorPosition(restoreLeft, restoreTop);
        }
        catch
        {
            try
            {
                Console.SetCursorPosition(left, top);
            }
            catch
            {
            }
            Console.WriteLine(prefix + notice);
        }
    }

    private static int GetOverlayBottomOffset()
    {
        var raw = Environment.GetEnvironmentVariable("BLUN_TELEGRAM_CONSOLE_UI_BOTTOM_OFFSET") ?? "";
        int parsed;
        if (int.TryParse(raw, out parsed) && parsed >= 2 && parsed <= 12)
        {
            return parsed;
        }
        return 3;
    }

    private static void BuildSnapshot(out string title, out string notice, out string uiNotice, out string uiKind)
    {
        title = _baseTitle;
        notice = "";
        uiNotice = "";
        uiKind = "";
        if (string.IsNullOrWhiteSpace(_stateFile) || !File.Exists(_stateFile))
        {
            return;
        }

        var raw = File.ReadAllText(_stateFile);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return;
        }

        var serializer = new JavaScriptSerializer();
        var root = serializer.DeserializeObject(raw) as Dictionary<string, object>;
        if (root == null || !root.ContainsKey("queue"))
        {
            return;
        }

        if (root.ContainsKey("lastUiNotice"))
        {
            var ui = root["lastUiNotice"] as Dictionary<string, object>;
            if (ui != null)
            {
                uiNotice = Normalize(GetString(ui, "text"), 220);
                uiKind = Normalize(GetString(ui, "kind"), 32);
            }
        }

        int total = 0;
        int direct = 0;
        int ambient = 0;
        int escalation = 0;
        string preview = "";

        var queue = AsObjects(root["queue"]);
        foreach (var item in queue)
        {
            var entry = item as Dictionary<string, object>;
            if (entry == null)
            {
                continue;
            }

            var status = GetString(entry, "status");
            if (!string.Equals(status, "queued", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var relevance = GetString(entry, "relevance");
            if (string.Equals(relevance, "ambient", StringComparison.OrdinalIgnoreCase) && IsOlderThan(entry, _ambientTtlMs))
            {
                continue;
            }

            total += 1;
            CountRelevance(entry, ref direct, ref ambient, ref escalation);

            if (string.IsNullOrWhiteSpace(preview))
            {
                preview = FormatPreview(entry, 44, false);
            }
        }

        if (total == 0)
        {
            return;
        }

        var parts = new List<string> { "Q:" + total.ToString() };
        if (direct > 0) parts.Add("D:" + direct.ToString());
        if (ambient > 0) parts.Add("G:" + ambient.ToString());
        if (escalation > 0) parts.Add("E:" + escalation.ToString());

        var suffix = string.Join(" ", parts.ToArray());
        title = _baseTitle + " | " + suffix;
        var noticeParts = new List<string> { total.ToString() + " queued" };
        if (direct > 0) noticeParts.Add("direct " + direct.ToString());
        if (ambient > 0) noticeParts.Add("group " + ambient.ToString());
        if (escalation > 0) noticeParts.Add("escalation " + escalation.ToString());
        notice = string.Join(" | ", noticeParts.ToArray());
        if (string.IsNullOrWhiteSpace(preview))
        {
            return;
        }
        title = title + " | " + preview;
        notice = notice + " | " + preview;
    }

    private static object[] AsObjects(object value)
    {
        var arr = value as object[];
        if (arr != null)
        {
            return arr;
        }
        var list = value as ArrayList;
        if (list != null)
        {
            return list.ToArray();
        }
        return new object[0];
    }

    private static string GetString(Dictionary<string, object> entry, string key)
    {
        if (!entry.ContainsKey(key) || entry[key] == null)
        {
            return "";
        }
        return Convert.ToString(entry[key]) ?? "";
    }

    private static void CountRelevance(Dictionary<string, object> entry, ref int direct, ref int ambient, ref int escalation)
    {
        var relevance = GetString(entry, "relevance");
        if (string.Equals(relevance, "ambient", StringComparison.OrdinalIgnoreCase))
        {
            ambient += 1;
        }
        else if (string.Equals(relevance, "escalation", StringComparison.OrdinalIgnoreCase))
        {
            escalation += 1;
        }
        else
        {
            direct += 1;
        }
    }

    private static bool IsOpenPendingReply(Dictionary<string, object> entry)
    {
        var status = GetString(entry, "status").Trim().ToLowerInvariant();
        if (entry.ContainsKey("sentAt") && entry["sentAt"] != null && !string.IsNullOrWhiteSpace(Convert.ToString(entry["sentAt"])))
        {
            return false;
        }
        if (status == "sent" || status == "suppressed_ack" || status == "error" || status == "ignored_bot" || status == "superseded" || status == "expired" || status == "stale_thread")
        {
            return false;
        }
        return true;
    }

    private static string FormatPreview(Dictionary<string, object> entry, int maxLength, bool pending)
    {
        var user = GetString(entry, "user");
        var group = GetString(entry, "groupTitle");
        var rawText = pending ? GetString(entry, "sourceText") : GetString(entry, "text");
        var text = Normalize(rawText, maxLength);
        if (string.IsNullOrWhiteSpace(text))
        {
            return "";
        }
        var state = pending ? "pending: " : "";
        if (!string.IsNullOrWhiteSpace(group))
        {
            return Normalize(state + user + "@" + group + ": " + text, maxLength);
        }
        if (!string.IsNullOrWhiteSpace(user))
        {
            return Normalize(state + user + ": " + text, maxLength);
        }
        return state + text;
    }

    private static string Normalize(string value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "";
        }

        var compact = RepairMojibake(value).Replace("\r", " ").Replace("\n", " ").Trim();
        while (compact.Contains("  "))
        {
            compact = compact.Replace("  ", " ");
        }

        if (compact.Length <= maxLength)
        {
            return compact;
        }

        return compact.Substring(0, Math.Max(0, maxLength - 3)).TrimEnd() + "...";
    }

    private static string RepairMojibake(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "";
        }

        return value
            .Replace("â€”", "-")
            .Replace("â€“", "-")
            .Replace("â€ž", "\"")
            .Replace("â€œ", "\"")
            .Replace("â€\u009d", "\"")
            .Replace("â€™", "'")
            .Replace("â€˜", "'")
            .Replace("â€¦", "...")
            .Replace("â‚¬", "EUR")
            .Replace("Ã„", "Ä")
            .Replace("Ã–", "Ö")
            .Replace("Ãœ", "Ü")
            .Replace("Ã¤", "ä")
            .Replace("Ã¶", "ö")
            .Replace("Ã¼", "ü")
            .Replace("ÃŸ", "ß");
    }

    private static bool IsOlderThan(Dictionary<string, object> entry, long ttlMs)
    {
        if (!entry.ContainsKey("ts") || entry["ts"] == null)
        {
            return true;
        }
        try
        {
            var parsed = DateTimeOffset.Parse(Convert.ToString(entry["ts"]) ?? "");
            return (DateTimeOffset.UtcNow - parsed.ToUniversalTime()).TotalMilliseconds >= ttlMs;
        }
        catch
        {
            return true;
        }
    }

    private static void WriteLog(string message)
    {
        if (string.IsNullOrWhiteSpace(_logFile))
        {
            return;
        }
        try
        {
            File.AppendAllText(_logFile, DateTimeOffset.UtcNow.ToString("o") + " " + message + Environment.NewLine);
        }
        catch
        {
        }
    }
}
"@
}

$ambientTtlMs = 600000
try {
  $stateDir = Split-Path -Parent $StateFile
  $envPath = Join-Path $stateDir ".env"
  if (Test-Path $envPath) {
    foreach ($line in (Get-Content -Path $envPath)) {
      if (-not $line) { continue }
      if ($line.Trim().StartsWith("#")) { continue }
      $parts = $line -split "=", 2
      if ($parts.Count -ne 2) { continue }
      if ($parts[0].Trim() -eq "BLUN_TELEGRAM_AMBIENT_QUEUE_TTL_MS") {
        $ambientTtlMs = [int64]$parts[1].Trim()
      }
    }
  }
} catch {
  $ambientTtlMs = 600000
}

[BlunEmbeddedQueueTitleWatcherQueueOnlyV2]::Start($StateFile, $BaseTitle, $ambientTtlMs, $LogFile)
