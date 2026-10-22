import { z } from "zod";

const Hex=z.string().regex(/^[0-9a-f]{64}$/),Generation=z.string().regex(/^[0-9a-f]{32}$/);
const Absolute=z.string().min(2).max(1024).regex(/^\/(?!\/)[^\u0000\r\n]+$/).refine(p=>!p.split("/").some(s=>s==="."||s===".."));
/** Private human-approved file identities, never an observation returned by an untrusted child. */
export const LinuxBrowserFilePinSchema=z.object({path:Absolute,device:z.number().int().nonnegative(),inode:z.number().int().positive(),size:z.number().int().positive().max(32*1024*1024),sha256:Hex}).strict();
export const LinuxBrowserFixtureLaunchSchema=z.object({
 version:z.literal(1),generation:Generation,nonce:Hex,target:z.literal("namespace_fixture_v1"),deadlineMs:z.number().int().min(500).max(10_000),
 owner:z.object({pid:z.number().int().positive(),startTicks:z.string().regex(/^[1-9][0-9]{0,19}$/),bootId:z.string().uuid()}).strict(),
 pins:z.object({bwrap:LinuxBrowserFilePinSchema,python:LinuxBrowserFilePinSchema,helper:LinuxBrowserFilePinSchema}).strict(),
}).strict();
export const LinuxBrowserFixtureReleaseSchema=z.object({op:z.literal("release"),generation:Generation,nonce:Hex}).strict();
function jsonBoundary(raw:unknown):unknown{
 let nodes=0,bytes=0;const active=new Set<object>();
 const visit=(v:unknown,d:number):void=>{
  if(++nodes>200||d>8)throw Error("linux_fixture_invalid_input");
  if(typeof v==="string"){bytes+=Buffer.byteLength(v);if(bytes>8192)throw Error("linux_fixture_invalid_input");return;}
  if(v===null||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v))return;
  if(!v||typeof v!=="object"||active.has(v)||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error("linux_fixture_invalid_input");
  active.add(v);for(const key of Object.keys(v)){const descriptor=Object.getOwnPropertyDescriptor(v,key);bytes+=Buffer.byteLength(key);if(bytes>8192||!descriptor||!("value"in descriptor))throw Error("linux_fixture_invalid_input");visit(descriptor.value,d+1);}active.delete(v);
 };visit(raw,0);return raw;
}
/** Pure launch authority prerequisite; deliberately cannot select a browser or return an isolation lease. */
export function planLinuxBrowserFixture(raw:unknown){
 const launch=LinuxBrowserFixtureLaunchSchema.parse(jsonBoundary(raw));
 if(launch.pins.bwrap.path!=="/usr/bin/bwrap"||launch.pins.python.path!=="/usr/bin/python3.10"||new Set(Object.values(launch.pins).map(p=>`${p.device}:${p.inode}`)).size!==3)throw Error("linux_fixture_unapproved_executable");
 return {version:1 as const,runtimeEnabled:false as const,target:"namespace_fixture_v1" as const,
  command:launch.pins.python.path,argv:["-I","-B",launch.pins.helper.path,"--monitor"],
  environment:{PATH:"/usr/bin:/bin",LANG:"C.UTF-8"},
  descriptors:{ownerControl:0,privateEvents:1,diagnostics:2,innerRelease:6,innerStatus:7,namespaceInfo:8},
  namespacePolicy:["user","net","mount","pid","ipc","uts","cgroup"],
  mountPolicy:"fixed_fixture_root_v1",resourcePolicy:"bounded_fixture_only_not_browser_containment",
  initialFrame:JSON.stringify(launch)+"\n"};
}
