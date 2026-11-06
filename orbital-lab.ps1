# Windows PowerShell 5.1+. This file must remain ASCII for legacy PowerShell.
param([string]$Action)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Action -notin @('start', 'stop', 'restart') -or $args.Count -ne 0) {
    Write-Host 'Usage: orbital-lab.cmd start|stop|restart'
    exit 2
}
$projectRoot = (Get-Item -LiteralPath $PSScriptRoot).FullName
$runtimeDir = Join-Path $projectRoot '.runtime'
$stateFile = Join-Path $runtimeDir 'server-windows.json'
$outLog = Join-Path $runtimeDir 'stdout-windows.log'
$errLog = Join-Path $runtimeDir 'stderr-windows.log'
$entryFile = Join-Path $projectRoot 'server\index.ts'
$controlLock = $null

function Quote-Argument([string]$Value) {
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Server-Command([string]$NodePath) {
    return (Quote-Argument $NodePath) + ' --import tsx ' + (Quote-Argument $entryFile) + ' --production'
}
function Read-State {
    if (!(Test-Path -LiteralPath $stateFile)) { return $null }
    try {
        $record = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.version -ne 1 -or "$($record.pid)" -notmatch '^[1-9][0-9]*$' -or
            "$($record.startTicks)" -notmatch '^[0-9]+$' -or
            "$($record.port)" -notmatch '^[0-9]{1,5}$' -or [int]$record.port -lt 1 -or [int]$record.port -gt 65535 -or
            $record.project -ne $projectRoot -or ![IO.Path]::IsPathRooted($record.node)) { throw 'Invalid process record.' }
        return $record
    } catch { throw "Cannot validate $stateFile. No process was stopped. Inspect the record before removing it." }
}
function Process-Identity($Record) {
    $serviceProcess = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if (!$serviceProcess) { return 'missing' }
    try {
        if ($serviceProcess.HasExited) { return 'missing' }
        if ([string]$serviceProcess.StartTime.ToUniversalTime().Ticks -ne [string]$Record.startTicks) { return 'mismatch' }
        $details = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Record.pid)"
        if (!$details) { return 'missing' }
        if ($details.ExecutablePath -ne $Record.node -or $details.CommandLine -cne (Server-Command $Record.node)) { return 'mismatch' }
        return 'match'
    } catch { throw 'Cannot verify the managed process identity. No process was stopped.' }
}
function Test-Health([int]$ServicePort) {
    try {
        $reply = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ServicePort/api/settings" -TimeoutSec 1 -Proxy $null
        $settings = $reply.Content | ConvertFrom-Json
        return $reply.StatusCode -eq 200 -and $settings.demoMode -is [bool]
    } catch { return $false }
}
function Stop-ServiceInstance {
    $record = Read-State
    if (!$record) { Write-Host 'Orbital Lab is not running under this script.'; return }
    $identity = Process-Identity $record
    if ($identity -eq 'mismatch') { throw 'Process identity does not match the record. Refusing to stop an unrelated process.' }
    if ($identity -eq 'match') {
        # Verify again immediately before sending the stop request.
        if ((Process-Identity $record) -ne 'match') { throw 'Process identity changed. Stop cancelled.' }
        Stop-Process -Id ([int]$record.pid) -Force -ErrorAction SilentlyContinue
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ((Process-Identity $record) -eq 'match' -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        if ((Process-Identity $record) -eq 'match') { throw 'The managed process did not stop. Restart cancelled.' }
    }
    Remove-Item -LiteralPath $stateFile
    Write-Host 'Orbital Lab stopped.'
}
function Start-ServiceInstance {
    $record = Read-State
    if ($record) {
        $identity = Process-Identity $record
        if ($identity -eq 'mismatch') { throw 'Process identity does not match the record. Refusing to start a second instance.' }
        if ($identity -eq 'match') {
            if ((Test-Health ([int]$record.port)) -and (Process-Identity $record) -eq 'match') {
                Write-Host "Orbital Lab is already running at http://127.0.0.1:$($record.port) (PID $($record.pid))."
                return
            }
            throw 'The managed process exists but is not healthy. Use stop or restart; no second instance was started.'
        }
        Remove-Item -LiteralPath $stateFile
    }
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$nodeCommand) { throw 'Node.js is required. Install Node.js 22.12+ (22.x) or 24+.' }
    $nodePath = $nodeCommand.Source
    $nodeVersion = [Version]((& $nodePath --version).Trim().TrimStart('v'))
    if (!(($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 12) -or $nodeVersion.Major -ge 24)) { throw 'Unsupported Node.js. Use Node.js 22.12+ (22.x) or 24+.' }
    foreach ($file in @('node_modules\tsx\package.json', 'node_modules\express\package.json', 'server\index.ts')) {
        if (!(Test-Path -LiteralPath (Join-Path $projectRoot $file) -PathType Leaf)) { throw 'Local dependencies or server files are missing. Run npm.cmd ci in the project root.' }
    }
    if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html') -PathType Leaf)) { throw 'Production build is missing. Run npm.cmd run build first.' }
    $portText = $env:PORT
    if ([string]::IsNullOrEmpty($portText)) { $portText = '5173' }
    if ($portText -notmatch '^[0-9]{1,5}$' -or [int]$portText -lt 1 -or [int]$portText -gt 65535) { throw 'PORT must be an integer between 1 and 65535.' }
    $servicePort = [int]$portText
    $env:PORT = [string]$servicePort
    $probe = New-Object Net.Sockets.TcpClient
    try {
        if ($probe.ConnectAsync('127.0.0.1', $servicePort).Wait(500) -and $probe.Connected) { throw "Port $servicePort is already in use. No process was stopped." }
    } catch [AggregateException] { } finally { $probe.Dispose() }
    # Append-only inherited file handles let Node outlive PowerShell without a log-pump process.
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class OrbitalBackground {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUP {
        public int cb; public string reserved; public string desktop; public string title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedSize;
        public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPEX { public STARTUP startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct INFO { public IntPtr process,thread; public int pid,tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref SECURITY security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPEX startup,out INFO info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static int Start(string node,string command,string directory,string stdout,string stderr) {
        var security=new SECURITY { length=Marshal.SizeOf(typeof(SECURITY)),inherit=true };
        IntPtr input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero;
        bool initialized=false;
        try {
            input=CreateFileW("NUL",0x80000000,7,ref security,3,0x80,IntPtr.Zero);
            output=CreateFileW(stdout,4,7,ref security,4,0x80,IntPtr.Zero);
            error=CreateFileW(stderr,4,7,ref security,4,0x80,IntPtr.Zero);
            foreach(var handle in new[]{input,output,error}) if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            // Limit inheritance to the three log/input handles; inherited control pipes would keep callers waiting.
            IntPtr size=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            attributes=Marshal.AllocHGlobal(size);
            if(!InitializeProcThreadAttributeList(attributes,1,0,ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            initialized=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size*3);
            Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var startup=new STARTUPEX { startup=new STARTUP { cb=Marshal.SizeOf(typeof(STARTUPEX)),flags=0x101,show=0,input=input,output=output,error=error },attributes=attributes };
            INFO info;
            if(!CreateProcessW(node,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08080200,IntPtr.Zero,directory,ref startup,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(info.thread); CloseHandle(info.process); return info.pid;
        } finally {
            if(initialized) DeleteProcThreadAttributeList(attributes);
            if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
            foreach(var handle in new[]{input,output,error}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
        }
    }
}
"@
    $processId = [OrbitalBackground]::Start($nodePath, (Server-Command $nodePath), $projectRoot, $outLog, $errLog)
    $record = $null
    try {
        $serviceProcess = Get-Process -Id $processId
        $record = [pscustomobject]@{ version=1; pid=$processId; startTicks=[string]$serviceProcess.StartTime.ToUniversalTime().Ticks; port=$servicePort; project=$projectRoot; node=$nodePath }
        [IO.File]::WriteAllText("$stateFile.tmp", ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath "$stateFile.tmp" -Destination $stateFile -Force
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ((Process-Identity $record) -ne 'match') { throw 'The server exited during startup.' }
            if ((Test-Health $servicePort) -and (Process-Identity $record) -eq 'match') {
                Write-Host "Orbital Lab started at http://127.0.0.1:$servicePort (PID $processId)."
                Write-Host "Logs: $outLog and $errLog"
                return
            }
            Start-Sleep -Milliseconds 200
        }
        throw 'The server was not ready within 30 seconds.'
    } catch {
        if ($record -and (Process-Identity $record) -eq 'match') { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile }
        if (Test-Path -LiteralPath "$stateFile.tmp") { Remove-Item -LiteralPath "$stateFile.tmp" }
        throw "Startup failed: $($_.Exception.Message) See $errLog and $outLog."
    }
}
try {
    [void][IO.Directory]::CreateDirectory($runtimeDir)
    try { $controlLock = [IO.File]::Open((Join-Path $runtimeDir 'control-windows.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another control command is running, or .runtime is not writable. Try again after it finishes.' }
    if ($Action -eq 'stop') { Stop-ServiceInstance }
    elseif ($Action -eq 'restart') { Stop-ServiceInstance; Start-ServiceInstance }
    else { Start-ServiceInstance }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($controlLock) { $controlLock.Dispose() }
}
