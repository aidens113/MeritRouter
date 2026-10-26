import { createWindowsJobExecutable } from "./windows-job-executable.js";

/** A trusted helper controls the Job handle; child output never carries completion authority. */
export const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
public static class MeritRouterCommandJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long User,Job; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,uint size,IntPtr returned);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder line,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static JavaScriptSerializer json=new JavaScriptSerializer(){MaxJsonLength=1048576,RecursionLimit=16};
 static string Text(Dictionary<string,object> cfg,string key){return (string)cfg[key];}
 static void Complete(Dictionary<string,object> cfg,string phase,int? code,string killed) {
  var data=new Dictionary<string,object>{{"version",1},{"id",cfg["id"]},{"nonce",cfg["nonce"]},{"backend","windows-job-v1"},{"phase",phase},{"activeProcesses",0},{"exitCode",code},{"killed",killed}};
  byte[] payload=Encoding.UTF8.GetBytes(json.Serialize(data));
  byte[] signature;using(var hmac=new HMACSHA256(Convert.FromBase64String(Text(cfg,"proofKey")))){signature=hmac.ComputeHash(payload);}
  string encoded=json.Serialize(new Dictionary<string,object>{{"payload",Convert.ToBase64String(payload)},{"signature",BitConverter.ToString(signature).Replace("-","").ToLowerInvariant()}});
  string file=Text(cfg,"proofPath"),temp=file+".tmp";
  using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] bytes=Encoding.UTF8.GetBytes(encoded);stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
  File.Move(temp,file);
 }
 static uint Active(IntPtr job){Accounting accounting;if(!QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Exception("job accounting unavailable");return accounting.Active;}
 public static int Main() {
  Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
  IntPtr job=IntPtr.Zero,environment=IntPtr.Zero;ProcessInfo process=new ProcessInfo();bool resumed=false;
  try {
   string raw=Console.In.ReadToEnd();if(raw.Length>1048576)throw new Exception("command control exceeds bound");
   var cfg=json.Deserialize<Dictionary<string,object>>(raw);
   if(File.Exists(Text(cfg,"cancelPath"))){Complete(cfg,"unsent",null,"cancelled");return 0;}
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("job object unavailable");
   var limits=new ExtendedLimits();limits.Basic.Flags=0x00002000;
   if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))throw new Exception("job limits unavailable");
   var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
   foreach(var item in (Dictionary<string,object>)cfg["environment"])env[item.Key]=(string)item.Value;
   environment=Marshal.StringToHGlobalUni(String.Join("\0",env.Select(item=>item.Key+"="+item.Value).ToArray())+"\0");
   string shell=Text(cfg,"shell"),command=Text(cfg,"command");
   var startup=new Startup();startup.cb=(uint)Marshal.SizeOf(typeof(Startup));startup.flags=0x00000100;
   startup.input=GetStdHandle(-10);startup.output=GetStdHandle(-11);startup.error=GetStdHandle(-12);
   if(!SetHandleInformation(startup.input,1,1)||!SetHandleInformation(startup.output,1,1)||!SetHandleInformation(startup.error,1,1))throw new Exception("command stdio handles unavailable");
   var line=new StringBuilder("\""+shell+"\" /d /s /c \""+command+"\"");
   if(!CreateProcess(shell,line,IntPtr.Zero,IntPtr.Zero,true,0x08000004|0x00000400,environment,Text(cfg,"cwd"),ref startup,out process)){Complete(cfg,"unsent",null,"spawn_failed");return 0;}
   if(!AssignProcessToJobObject(job,process.process)){
    if(!TerminateProcess(process.process,1)||WaitForSingleObject(process.process,10000)!=0)throw new Exception("unassigned suspended process cleanup unproved");
    Complete(cfg,"unsent",null,"containment_unavailable");return 0;
   }
   if(ResumeThread(process.thread)==0xffffffff){if(!TerminateJobObject(job,1))throw new Exception("resume cleanup unavailable");}
   else resumed=true;
   var clock=Stopwatch.StartNew();long timeout=Convert.ToInt64(cfg["timeoutMs"]);string killed=resumed?null:"spawn_failed";long stopping=-1;
   for(;;){
    uint count=Active(job);
    if(count==0){uint code;if(!GetExitCodeProcess(process.process,out code)||code==259)throw new Exception("primary process completion unproved");Complete(cfg,"quiescent",unchecked((int)code),killed);return 0;}
    if(stopping<0&&(File.Exists(Text(cfg,"cancelPath"))||clock.ElapsedMilliseconds>=timeout||!resumed)){
     killed=!resumed?"spawn_failed":File.Exists(Text(cfg,"cancelPath"))?"cancelled":"timeout";
     if(!TerminateJobObject(job,1))throw new Exception("job termination unavailable");stopping=clock.ElapsedMilliseconds;
    }
    if(stopping>=0&&clock.ElapsedMilliseconds-stopping>10000)throw new Exception("job quiescence not established within cleanup budget");
    Thread.Sleep(20);
   }
  } catch(Exception){Console.Error.WriteLine("MeritRouter command containment could not prove completion; guard retained.");return 2;}
  finally {if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);if(job!=IntPtr.Zero)CloseHandle(job);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);}
 }
}
`;
export const windowsCommandJobExecutable = createWindowsJobExecutable(WINDOWS_JOB_SOURCE, "command");
