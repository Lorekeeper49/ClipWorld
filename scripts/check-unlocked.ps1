# Checks that no program has the previous build's files open, because Windows can't replace a file that
# is open. Lists every program that does (asking Windows' Restart Manager, the same thing installers use)
# so you know exactly what to close. Exits with 1 when something is holding a file.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-unlocked.ps1 dist\win-unpacked
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Folders)

$files = foreach ($f in $Folders) { if (Test-Path $f) { Get-ChildItem -LiteralPath $f -Recurse -File | ForEach-Object FullName } }
if (-not $files) { exit 0 }

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ClipWorldLocks {
  [StructLayout(LayoutKind.Sequential)] struct UNIQUE_PROCESS { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME started; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESS_INFO {
    public UNIQUE_PROCESS process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
    public int type; public int status; public int session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApps, UNIQUE_PROCESS[] apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] PROCESS_INFO[] info, ref uint reasons);

  /// <summary>"pid|name" of every process holding any of the files open.</summary>
  public static string[] Holders(string[] files) {
    var found = new List<string>();
    uint h;
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return found.ToArray();
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null) != 0) return found.ToArray();
      uint needed = 0, count = 0, reasons = 0;
      if (RmGetList(h, out needed, ref count, null, ref reasons) == 234) {
        var info = new PROCESS_INFO[needed];
        count = needed;
        if (RmGetList(h, out needed, ref count, info, ref reasons) == 0)
          for (int i = 0; i < count; i++) found.Add(info[i].process.pid + "|" + info[i].app);
      }
    } finally { RmEndSession(h); }
    return found.ToArray();
  }
}
"@

$holders = [ClipWorldLocks]::Holders([string[]]$files)
if (-not $holders) { exit 0 }

Write-Host ''
Write-Host 'These programs have files from the last build open, so Windows will not let the build replace them:'
# One line per program, however many processes it runs.
$rows = foreach ($h in $holders) {
  $id, $name = $h -split '\|', 2
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  [pscustomobject]@{ Name = $name; Id = $id; Exe = $(if ($proc) { $proc.ExecutablePath } else { '' }) }
}
foreach ($g in $rows | Group-Object Name, Exe) {
  $first = $g.Group[0]
  $ids = ($g.Group | ForEach-Object Id) -join ', '
  $label = if ($g.Count -gt 1) { "processes $ids" } else { "process $ids" }
  Write-Host ("  - {0} ({1}){2}" -f $first.Name, $label, $(if ($first.Exe) { "`n      $($first.Exe)" } else { '' }))
}
Write-Host ''
Write-Host 'Close them (or, for an editor, close any file or folder from dist it has open) and run this again.'
Write-Host 'If it is OneDrive, it is still uploading the last build: wait a moment, or pause syncing while you build.'
exit 1
