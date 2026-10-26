import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { minimalEnv } from "../runners/coding/process.js";
import { createWindowsJobExecutable } from "./windows-job-executable.js";

/** A live helper retains its named Job even after command exit, for restart-safe kernel proof. */
export const WINDOWS_SERVICE_JOB_SOURCE = String.raw`
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
public static class MeritRouterServiceJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long User,Job; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder line,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static JavaScriptSerializer json=new JavaScriptSerializer(){MaxJsonLength=1048576,RecursionLimit=16};
 static string Text(Dictionary<string,object> c,string k){return (string)c[k];}
 static uint Active(IntPtr job){Accounting a;if(!QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Exception("job accounting unavailable");return a.Active;}
 static string Created(uint pid){using(var p=Process.GetProcessById((int)pid)){return p.StartTime.ToUniversalTime().Ticks.ToString();}}
 static string Image(uint pid){using(var p=Process.GetProcessById((int)pid)){return Path.GetFullPath(p.MainModule.FileName);}}
 static void Proof(Dictionary<string,object> cfg,Dictionary<string,object> data){
  byte[] payload=Encoding.UTF8.GetBytes(json.Serialize(data)),signature;
  using(var hmac=new HMACSHA256(Convert.FromBase64String(Text(cfg,"proofKey"))))signature=hmac.ComputeHash(payload);
  string output=json.Serialize(new Dictionary<string,object>{{"payload",Convert.ToBase64String(payload)},{"signature",BitConverter.ToString(signature).Replace("-","").ToLowerInvariant()}}),file=Text(cfg,"proofPath");
  using(var s=new FileStream(file+".tmp",FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] b=Encoding.UTF8.GetBytes(output);s.Write(b,0,b.Length);s.Flush(true);}File.Move(file+".tmp",file);
 }
 static string Quote(string arg){var b=new StringBuilder("\"");int slashes=0;foreach(char c in arg){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString();}
 static int Inspect(Dictionary<string,object> cfg){
  uint helper=Convert.ToUInt32(cfg["helperPid"]),pid=Convert.ToUInt32(cfg["pid"]);
  if(helper==(uint)Process.GetCurrentProcess().Id||Created(helper)!=Text(cfg,"helperCreated")||!String.Equals(Image(helper),Text(cfg,"helperImage"),StringComparison.OrdinalIgnoreCase))throw new Exception("helper identity unavailable");
  IntPtr job=OpenJobObject(0x0004|0x0008,false,Text(cfg,"jobName"));if(job==IntPtr.Zero)throw new Exception("original named Job unavailable");
  try{
   bool member=false,same=false;IntPtr process=OpenProcess(0x1000,false,pid);
   if(process!=IntPtr.Zero){try{try{same=Created(pid)==Text(cfg,"created");if(same&&!IsProcessInJob(process,job,out member))throw new Exception("job membership unavailable");}catch{same=false;member=false;}}finally{CloseHandle(process);}}
   if((bool)cfg["stop"]){if(!TerminateJobObject(job,1))throw new Exception("job termination unavailable");var clock=Stopwatch.StartNew();while(Active(job)!=0){if(clock.ElapsedMilliseconds>10000)throw new Exception("quiescence budget exceeded");Thread.Sleep(20);}}
   var data=new Dictionary<string,object>{{"version",1},{"backend","windows-service-job-v1"},{"id",cfg["id"]},{"nonce",cfg["nonce"]},{"jobName",cfg["jobName"]},{"helperPid",helper},{"helperCreated",cfg["helperCreated"]},{"helperImage",cfg["helperImage"]},{"pid",pid},{"created",cfg["created"]},{"activeProcesses",Active(job)},{"primaryMember",member&&same}};
   Proof(cfg,data);return 0;
  }finally{CloseHandle(job);}
 }
 public static int Main(){
  IntPtr job=IntPtr.Zero,environment=IntPtr.Zero;ProcessInfo process=new ProcessInfo();bool assigned=false;FileStream output=null;
  try{
   string raw;using(var input=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false))){raw=input.ReadToEnd();}if(raw.Length>1048576)throw new Exception("control exceeds bound");var cfg=json.Deserialize<Dictionary<string,object>>(raw);
   if(Text(cfg,"mode")=="inspect")return Inspect(cfg);
   job=CreateJobObject(IntPtr.Zero,Text(cfg,"jobName"));int existing=Marshal.GetLastWin32Error();if(job==IntPtr.Zero||existing==183)throw new Exception("named Job was not created exclusively");
   var limits=new ExtendedLimits();limits.Basic.Flags=0x00002000;if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))throw new Exception("job limits unavailable");
   var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(var item in (Dictionary<string,object>)cfg["environment"])env[item.Key]=(string)item.Value;
   environment=Marshal.StringToHGlobalUni(String.Join("\0",env.Select(item=>item.Key+"="+item.Value).ToArray())+"\0");
   string app=Text(cfg,"file");var args=(System.Collections.IEnumerable)cfg["args"];var line=new StringBuilder(Quote(app)+" "+String.Join(" ",args.Cast<object>().Select(a=>Quote((string)a)).ToArray()));
   output=new FileStream(Text(cfg,"logPath"),FileMode.Append,FileAccess.Write,FileShare.ReadWrite);
   var startup=new Startup();startup.cb=(uint)Marshal.SizeOf(typeof(Startup));startup.flags=0x100;startup.input=GetStdHandle(-10);startup.output=output.SafeFileHandle.DangerousGetHandle();startup.error=startup.output;
   if(!SetHandleInformation(startup.input,1,1)||!SetHandleInformation(startup.output,1,1)||!SetHandleInformation(startup.error,1,1))throw new Exception("stdio unavailable");
   if(!CreateProcess(app,line,IntPtr.Zero,IntPtr.Zero,true,0x08000004|0x400,environment,Text(cfg,"cwd"),ref startup,out process))throw new Exception("suspended process unavailable");
   if(!AssignProcessToJobObject(job,process.process))throw new Exception("job assignment unavailable");assigned=true;
   bool member;if(!IsProcessInJob(process.process,job,out member)||!member||Active(job)!=1)throw new Exception("suspended job membership unproved");
   uint helper=(uint)Process.GetCurrentProcess().Id;
   Proof(cfg,new Dictionary<string,object>{{"version",1},{"backend","windows-service-job-v1"},{"id",cfg["id"]},{"nonce",cfg["nonce"]},{"jobName",cfg["jobName"]},{"helperPid",helper},{"helperCreated",Created(helper)},{"helperImage",Image(helper)},{"pid",process.pid},{"created",Created(process.pid)},{"activeProcesses",1},{"primaryMember",true}});
   var grant=Stopwatch.StartNew();while(!File.Exists(Text(cfg,"grantPath"))){if(File.Exists(Text(cfg,"releasePath"))&&Active(job)==0)return 0;if(File.Exists(Text(cfg,"cancelPath"))||grant.ElapsedMilliseconds>30000){if(!TerminateJobObject(job,1))throw new Exception("ungranted Job cleanup unavailable");var stopped=Stopwatch.StartNew();while(Active(job)!=0){if(stopped.ElapsedMilliseconds>10000)throw new Exception("ungranted Job quiescence unproved");Thread.Sleep(20);}while(!File.Exists(Text(cfg,"releasePath")))Thread.Sleep(20);return 0;}Thread.Sleep(20);}
   if(ResumeThread(process.thread)==0xffffffff)throw new Exception("process resume unavailable");
   var clock=Stopwatch.StartNew();long timeout=cfg["timeoutMs"]==null?0:Convert.ToInt64(cfg["timeoutMs"]);bool stopping=false;
   for(;;){if(File.Exists(Text(cfg,"releasePath"))){if(Active(job)!=0)throw new Exception("release before kernel quiescence");return 0;}
    if(!stopping&&(File.Exists(Text(cfg,"cancelPath"))||(timeout>0&&clock.ElapsedMilliseconds>=timeout))){if(!TerminateJobObject(job,1))throw new Exception("service termination unavailable");stopping=true;}
    Thread.Sleep(20);
   }
  }catch(Exception error){Console.Error.WriteLine("MeritRouter service Job ownership/quiescence unproved: "+error.Message);return 2;}
  finally{if(process.process!=IntPtr.Zero&&!assigned){TerminateProcess(process.process,1);WaitForSingleObject(process.process,10000);}if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);if(job!=IntPtr.Zero)CloseHandle(job);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(output!=null)output.Dispose();}
 }
}
`;

const executable = createWindowsJobExecutable(WINDOWS_SERVICE_JOB_SOURCE, "service");
const id = z.string().regex(/^rc_[a-f0-9]{32}$/), nonce = z.string().regex(/^[a-f0-9]{64}$/), ticks = z.string().regex(/^\d{1,24}$/);
export const ServiceJobBindingSchema = z.object({ version: z.literal(1), backend: z.literal("windows-service-job-v1"), id, nonce,
  jobName: z.string().regex(/^Local\\MeritRouter\.ServiceJob\.[a-f0-9]{64}$/), helperPid: z.number().int().positive(), helperCreated: ticks,
  helperImage: z.string().min(1).max(4096), pid: z.number().int().positive(), created: ticks }).strict();
export type ServiceJobBinding = z.infer<typeof ServiceJobBindingSchema>;
const Observation = ServiceJobBindingSchema.extend({ activeProcesses: z.number().int().nonnegative(), primaryMember: z.boolean() }).strict();
const Input = z.object({ file: z.string().refine(value => path.resolve(value).toLowerCase() === path.resolve(process.execPath).toLowerCase()),
  args: z.array(z.string().max(131072).refine(value => !value.includes("\0"))).max(32).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024),
  cwd: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0")), env: z.record(z.string().min(1).max(200).refine(value => !/[=\0]/.test(value)), z.string().max(65536).refine(value => !value.includes("\0"))).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024),
  timeoutMs: z.number().int().positive().max(86400000).nullable() }).strict();
export type ServiceCommandInput = z.infer<typeof Input>;
declare const observationBrand: unique symbol;
export interface ServiceJobObservation { readonly [observationBrand]: true }
const observations = new WeakMap<object, z.infer<typeof Observation>>();
const liveHelpers = new Map<number, { created: string; exited: Promise<void> }>();
export function serviceJobObservation(proof: ServiceJobObservation): z.infer<typeof Observation> {
  const value = proof && typeof proof === "object" ? observations.get(proof) : undefined;
  if (!value) throw new Error("Forged service Job observation"); return Observation.parse(value);
}
async function observed(file: string, key: Buffer): Promise<z.infer<typeof Observation>> {
  const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error("Unsafe native service proof");
  const envelope = z.object({ payload: z.string().max(8192), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse((await readFile(file)).toString("utf8")));
  const payload = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "hex");
  if (!timingSafeEqual(signature, createHmac("sha256", key).update(payload).digest())) throw new Error("Native service proof authentication failed");
  return Observation.parse(JSON.parse(payload.toString("utf8")));
}
async function write(file: string, content: string): Promise<void> { const handle = await open(file, "wx", 0o600); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); } }
export async function startServiceCommandProcess(input: ServiceCommandInput, control: { id: string; nonce: string; directory: string; logPath?: string }, beforeGrant: (binding: ServiceJobBinding) => Promise<void>): Promise<ServiceJobBinding> {
  const parsed = Input.parse(input); id.parse(control.id); nonce.parse(control.nonce);
  if (process.platform !== "win32") throw new Error("Verified service Job containment unavailable on this platform");
  const image = await executable(), key = randomBytes(32), proofPath = path.join(control.directory, "prepared.json"), grantPath = path.join(control.directory, "job-grant"), releasePath = path.join(control.directory, "job-release"), cancelPath = path.join(control.directory, "job-cancel");
  const jobName = `Local\\MeritRouter.ServiceJob.${control.nonce}`;
  const child = spawn(image, [], { cwd: parsed.cwd, env: minimalEnv({}), detached: true, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("close", () => { if (child.pid) liveHelpers.delete(child.pid); resolve(); }));
  let diagnostic = ""; child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192); });
  let ended = false; child.on("error", () => { ended = true; }); child.on("exit", () => { ended = true; }); child.stdin.on("error", () => {});
  let assigned: ServiceJobBinding | undefined;
  child.stdin.end(JSON.stringify({ mode: "launch", ...parsed, environment: parsed.env, id: control.id, nonce: control.nonce, jobName, proofKey: key.toString("base64"), proofPath, grantPath, releasePath, cancelPath, logPath: control.logPath ?? path.join(control.directory, "process.log") }));
  try {
    const deadline = Date.now() + 15000; let result: z.infer<typeof Observation>;
    for (;;) { try { result = await observed(proofPath, key); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (ended || Date.now() > deadline) throw new Error(`Native service suspended-assignment proof unavailable: ${diagnostic}`); await new Promise(resolve => setTimeout(resolve, 20)); } }
    const { activeProcesses, primaryMember, ...raw } = result!; const binding = ServiceJobBindingSchema.parse(raw);
    if (activeProcesses !== 1 || !primaryMember || binding.id !== control.id || binding.nonce !== control.nonce || binding.jobName !== jobName || binding.helperPid !== child.pid || path.resolve(binding.helperImage).toLowerCase() !== path.resolve(image).toLowerCase()) throw new Error("Native service preparation identity mismatch");
    assigned = binding; liveHelpers.set(binding.helperPid, { created: binding.helperCreated, exited });
    await beforeGrant(binding); await write(grantPath, "granted"); child.unref();
    (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.(); return binding;
  } catch (error) {
    if (assigned) { child.unref(); (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.(); }
    else child.kill();
    throw error;
  } finally { key.fill(0); }
}
export async function inspectServiceCommandProcess(binding: ServiceJobBinding, directory: string, stop = false): Promise<ServiceJobObservation> {
  const parsed = ServiceJobBindingSchema.parse(binding), image = await executable();
  if (path.resolve(image).toLowerCase() !== path.resolve(parsed.helperImage).toLowerCase()) throw new Error("Service helper executable identity changed");
  const key = randomBytes(32), proofPath = path.join(directory, `observe-${randomBytes(12).toString("hex")}.json`);
  const child = spawn(image, [], { env: minimalEnv({}), windowsHide: true, stdio: ["pipe", "ignore", "ignore"] }); child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ ...parsed, mode: "inspect", stop, proofKey: key.toString("base64"), proofPath }));
  const deadline = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    if (code !== 0) throw new Error("Original service helper or named Job could not be verified");
    const value = await observed(proofPath, key), { activeProcesses, primaryMember, ...actual } = value;
    if (JSON.stringify(actual) !== JSON.stringify(parsed)) throw new Error("Service Job observation identity changed");
    if (stop && activeProcesses !== 0) throw new Error("Service Job descendants remain active");
    const proof = Object.freeze({}) as ServiceJobObservation; observations.set(proof, value); return proof;
  } finally { clearTimeout(deadline); key.fill(0); }
}
export async function releaseServiceCommandProcess(binding: ServiceJobBinding, directory: string, proof: ServiceJobObservation): Promise<void> {
  const { activeProcesses, primaryMember: _primaryMember, ...actual } = serviceJobObservation(proof);
  if (activeProcesses !== 0 || JSON.stringify(actual) !== JSON.stringify(ServiceJobBindingSchema.parse(binding))) throw new Error("Service helper release requires its exact kernel-zero proof");
  await write(path.join(directory, "job-release"), "kernel-quiescent");
  const local = liveHelpers.get(binding.helperPid), until = Date.now() + 10000;
  if (local?.created === binding.helperCreated) {
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([local.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Quiescent service helper exit is still pending")), 10000); })]); }
    finally { clearTimeout(timer!); }
  } else for (;;) {
    try { process.kill(binding.helperPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
    if (Date.now() > until) throw new Error("Quiescent recovered service helper exit is still pending");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
