import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { planLinuxBrowserFixture, LinuxBrowserFixtureReleaseSchema } from "../src/labs/browser-linux-plan.js";
const pin=(file:string,inode:number)=>({path:file,device:1,inode,size:123,sha256:"a".repeat(64)});
function fixture(){return {version:1,generation:"1".repeat(32),nonce:"2".repeat(64),target:"namespace_fixture_v1",deadlineMs:2000,owner:{pid:123,startTicks:"456",bootId:"12345678-1234-4234-8234-123456789abc"},pins:{bwrap:pin("/usr/bin/bwrap",1),python:pin("/usr/bin/python3.10",2),helper:pin("/tmp/owned/entry.py",3)}};}
describe("Linux browser fixture launch prerequisite",()=>{
 it("creates only fixed helper authority, not a browser lease",()=>{const input=fixture(),before=JSON.stringify(input),plan=planLinuxBrowserFixture(input);expect(plan).toMatchObject({runtimeEnabled:false,target:"namespace_fixture_v1",command:"/usr/bin/python3.10",argv:["-I","-B","/tmp/owned/entry.py","--monitor"],descriptors:{innerRelease:6,innerStatus:7,namespaceInfo:8}});expect(JSON.stringify(input)).toBe(before);expect(JSON.parse(plan.initialFrame)).toEqual(input);});
 it.each(["target","extra","environment","mounts","pin","alias","deadline","path"])("refuses %s authority",kind=>{const f:any=fixture();if(kind==="target")f.target="chrome";if(kind==="extra")f.evaluate="private";if(kind==="environment")f.env={SECRET:"private"};if(kind==="mounts")f.mounts=["/run"];if(kind==="pin")f.pins.bwrap.path="/bin/sh";if(kind==="alias")f.pins.helper.inode=1;if(kind==="deadline")f.deadlineMs=10001;if(kind==="path")f.pins.helper.path="/tmp/../host";expect(()=>planLinuxBrowserFixture(f)).toThrow();});
 it("rejects malformed/cyclic/accessor/oversized input before executing getters",()=>{let called=false;for(const f of [null,{...fixture(),nonce:"x".repeat(9000)},Object.defineProperty({},"version",{enumerable:true,get(){called=true;throw Error("secret");}})])expect(()=>planLinuxBrowserFixture(f)).toThrow();const cyclic:any={};cyclic.self=cyclic;expect(()=>planLinuxBrowserFixture(cyclic)).toThrow();expect(called).toBe(false);});
 it("has no extra release authority",()=>{expect(LinuxBrowserFixtureReleaseSchema.safeParse({op:"release",generation:"1".repeat(32),nonce:"2".repeat(64),argv:["sh"]}).success).toBe(false);});
});
const native=process.env.SWITCHYARD_TEST_LINUX_HELPER==="1";
it.skipIf(!native).each(["root","ordinary"])("runs owned installed Linux namespace/helper fixtures as %s",mode=>{
 const root=path.resolve(".");
 const linux=(p:string)=>process.platform==="win32"?"/mnt/"+p[0]!.toLowerCase()+p.slice(2).replaceAll("\\","/"):p;
 const args=["-I","-B",linux(path.join(root,"tests/fixtures/browser-linux-helper-fixture.py")),linux(path.join(root,"src/labs/browser-linux-helper.py"))];
 const executable=mode==="ordinary"?"/usr/bin/setpriv":"/usr/bin/python3.10";
 const commandArgs=mode==="ordinary"?["--reuid","65534","--regid","65534","--clear-groups","/usr/bin/python3.10",...args]:args;
 const result=process.platform==="win32"?spawnSync("wsl.exe",["-d","Ubuntu","--",executable,...commandArgs],{encoding:"utf8",timeout:45000,maxBuffer:100000}):spawnSync(executable,commandArgs,{encoding:"utf8",timeout:45000,maxBuffer:100000});
 expect(result.status,result.stdout+result.stderr).toBe(0);expect(result.error).toBeUndefined();expect(result.stdout).toContain('"failures": 0');expect(result.stdout).toContain('"errors": 0');expect(result.stdout).toContain('"ownerUid": '+(mode==="root"?0:65534));
},50000);
