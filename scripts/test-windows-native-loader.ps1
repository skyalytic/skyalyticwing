param([Parameter(Mandatory=$true)][string]$InstallDirectory)
$ErrorActionPreference='Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit PowerShell for native loader verification.' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class WingNativeLoader {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct STARTUPINFO { public uint cb; public IntPtr reserved,desktop,title; public uint x,y,cx,cy,xchars,ychars,fill,flags; public ushort show,cbReserved; public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Explicit,Size=176)] struct DEBUGEVENT {
  [FieldOffset(0)] public uint code; [FieldOffset(4)] public uint pid; [FieldOffset(8)] public uint tid;
  [FieldOffset(16)] public IntPtr file; [FieldOffset(16)] public uint exception;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESSINFO pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WaitForDebugEvent(out DEBUGEVENT e,uint timeout);
 [DllImport("kernel32.dll")] static extern bool ContinueDebugEvent(uint pid,uint tid,uint status);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint exit);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder text,uint length,uint flags);
 public static string[] Inspect(string executable) {
  // Stop at the loader's first breakpoint: Wing's entrypoint, profile access,
  // single-instance handling and sidecar launch have not run.
  var si=new STARTUPINFO(); si.cb=(uint)Marshal.SizeOf(si);
  PROCESSINFO pi; var dlls=new List<string>();
  string win=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
  var env=Marshal.StringToHGlobalUni("PATH="+win+"\\System32\0SystemRoot="+win+"\0TEMP="+Path.GetTempPath()+"\0\0");
  bool started=false,ready=false; DEBUGEVENT e;
  try {
   if(!CreateProcess(executable,new StringBuilder("\""+executable+"\""),IntPtr.Zero,IntPtr.Zero,false,0x08000402,env,Path.GetDirectoryName(executable),ref si,out pi)) throw new Win32Exception(Marshal.GetLastWin32Error());
   started=true;
   try {
    var deadline=DateTime.UtcNow.AddSeconds(30);
    while(DateTime.UtcNow<deadline) {
     if(!WaitForDebugEvent(out e,1000)) continue;
     if(e.code==6 || e.code==3) {
      if(e.file!=IntPtr.Zero && e.file!=new IntPtr(-1)) {
       var path=new StringBuilder(32768);
       if(GetFinalPathNameByHandle(e.file,path,32768,0)>0) dlls.Add(path.ToString().Replace("\\\\?\\",""));
       CloseHandle(e.file);
      }
     }
     if(e.code==1) {
      if(e.exception==0x80000003) { ready=true; TerminateProcess(pi.process,0); }
      else { TerminateProcess(pi.process,1); ContinueDebugEvent(e.pid,e.tid,0x10002); throw new Exception("Native loader exception 0x"+e.exception.ToString("x8")); }
     }
     ContinueDebugEvent(e.pid,e.tid,0x10002);
     if(e.code==5) break;
    }
    if(!ready) throw new Exception("Native image did not complete DLL loading");
   } finally { if(started) { TerminateProcess(pi.process,0); CloseHandle(pi.thread); CloseHandle(pi.process); } }
  } finally { Marshal.FreeHGlobal(env); }
  return dlls.ToArray();
 }
}
'@
$taskInstall = (Resolve-Path -LiteralPath $InstallDirectory).Path
$taskCases = @(
  @{path='skyalyticwing.exe'; required=@('vcruntime140.dll','vcruntime140_1.dll')},
  @{path='_up_/packages/web/binaries/windows-bridge.exe'; required=@('vcruntime140.dll')},
  @{path='_up_/packages/backend/deploy/python/python.exe'; required=@('vcruntime140.dll')}
)
foreach ($taskCase in $taskCases) {
  $taskExe = Join-Path $taskInstall $taskCase.path
  $taskLoaded = [WingNativeLoader]::Inspect($taskExe)
  foreach ($taskDll in $taskCase.required) {
    $taskExpected = [IO.Path]::GetFullPath((Join-Path (Split-Path $taskExe) $taskDll))
    if (-not ($taskLoaded -contains $taskExpected)) { throw "App-local dependency not loaded: $taskExpected" }
  }
  foreach ($taskModule in $taskLoaded) {
    $taskName = [IO.Path]::GetFileName($taskModule)
    if ($taskName -match '^(vcruntime|msvcp|concrt)140' -and -not $taskModule.StartsWith($taskInstall,[StringComparison]::OrdinalIgnoreCase)) {
      throw "Borrowed system VC runtime: $taskModule"
    }
  }
  Write-Output "PASS: $($taskCase.path) loads packaged VC runtime with no developer PATH; stopped before application code."
}
