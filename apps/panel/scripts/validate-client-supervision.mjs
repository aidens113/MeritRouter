#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import YAML from "yaml";

import { Switchyard, loadConfig } from "switchyard-router";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routerRequire = createRequire(path.resolve(app,"../../packages/router/package.json"));
const { Client } = await import(pathToFileURL(routerRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(routerRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
const demo = path.join(app, ".demo"); mkdirSync(demo, {recursive:true});
const fixture = mkdtempSync(path.join(demo, "client-supervision-"));
const screenshots = path.join(demo, "client-supervision-screenshots"); mkdirSync(screenshots,{recursive:true});
const config = path.join(fixture, "switchyard.config.yaml"); const repo = path.join(fixture, "repo"); mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C",repo,"-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","--allow-empty","-qm","fixture"]);
writeFileSync(config,YAML.stringify({version:1,profiles:{},providers:{},storage:{directory:".switchyard"},brain:{project:"demo",path:"brain"},repositories:{core:{path:"repo"}},discovery:{interval_minutes:0},panel:{auto_start:false,port:4499},paid:{enabled:false}})+"# preserved policy fixture comment\n");
const before = YAML.parse(readFileSync(config,"utf8")); const sy = new Switchyard(loadConfig(config),{worker:false});
const client = new Client({name:"production-policy-browser",version:"1"});
const require = createRequire(import.meta.url); const port=4499, cdpPort=9371, base=`http://127.0.0.1:${port}`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(100);}throw new Error(label);}
let server,chrome,ws; let id=0; const pending=new Map(); const errors=[];
function command(method,params={}){return new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>reject(new Error(method)),45000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject});ws.send(JSON.stringify({id:key,method,params}));});}
async function evaluate(expression){const r=await command("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result?.value;}
const blocks=r=>r.content;
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve(app,"../../packages/router/dist/cli.js"),"mcp","--config",config,"--no-worker"],env:{PATH:process.env.PATH??"",SWITCHYARD_PANEL_DIR:path.join(fixture,"no-panel")}}));
 assert(client.getInstructions().includes("Delegate as much practical work"));
 server=spawn(process.execPath,[require.resolve("next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(port)],{cwd:app,env:{...process.env,SWITCHYARD_CONFIG:config,SWITCHYARD_PROJECT:"",SWITCHYARD_PANEL_TOKEN:""},stdio:"ignore",windowsHide:true});
 await until(async()=>{try{return(await fetch(base+"/all/settings")).ok;}catch{return false;}},"panel readiness");
 const invalid=await fetch(base+"/api/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({patch:[{path:["client_supervision","instructions"],value:"x".repeat(8001)}]})});assert.equal(invalid.status,400);
 const chromePath=[process.env.CHROME_PATH,"C:/Program Files/Google/Chrome/Application/chrome.exe"].find(p=>p&&existsSync(p));assert(chromePath);
 chrome=spawn(chromePath,["--headless=new","--disable-gpu","--no-first-run",`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${path.join(fixture,"chrome")}`,"about:blank"],{stdio:"ignore",windowsHide:true});
 let target; await until(async()=>{try{target=(await(await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t=>t.type==="page");return !!target;}catch{return false;}},"chrome readiness");
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener("open",r,{once:true}));ws.addEventListener("message",event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result);}if(m.method==="Runtime.exceptionThrown")errors.push(m.params);});await command("Page.enable");await command("Runtime.enable");
 await command("Page.navigate",{url:base+"/all/settings#client-supervision"});
 await until(async()=>await evaluate("!!document.getElementById('f-client_supervision.dispatch_final_supervisor')"),"policy section");
 await until(async()=>await evaluate("Object.keys(document.getElementById('f-client_supervision.instructions')).some(k=>k.startsWith('__reactProps'))"),"React hydration");
 assert.equal(await evaluate("document.getElementById('f-client_supervision.dispatch_final_supervisor').checked"),false);
 await evaluate("document.querySelector('label[for=\"f-client_supervision.dispatch_final_supervisor\"]').click();const e=document.getElementById('f-client_supervision.instructions');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Browser customized final checks\\nReview browser evidence');e.dispatchEvent(new Event('input',{bubbles:true}));");
 await until(async()=>await evaluate("!document.getElementById('client-supervision').querySelector('button').disabled"),"edited form becomes dirty");
 await evaluate("document.getElementById('client-supervision').querySelector('button').click()");
 await until(()=>{const raw=YAML.parse(readFileSync(config,'utf8'));return raw.client_supervision?.dispatch_final_supervisor===true&&raw.client_supervision?.instructions==='Browser customized final checks\nReview browser evidence';},"UI save persisted");
 let result=await client.callTool({name:"get_supervision_policy",arguments:{}});assert.equal(blocks(result).length,2);assert.equal(JSON.parse(blocks(result)[0].text).dispatch_final_supervisor,true);assert(blocks(result)[1].text.includes("final supervisors are permitted"));
 result=await client.callTool({name:"get_supervision_policy",arguments:{}});assert.equal(blocks(result).length,1);
 await command("Page.reload");await until(async()=>await evaluate("document.getElementById('f-client_supervision.instructions')?.value==='Browser customized final checks\\nReview browser evidence'"),"UI reload");assert.equal(await evaluate("document.getElementById('f-client_supervision.dispatch_final_supervisor').checked"),true);
 result=await client.callTool({name:"set_supervision_policy",arguments:{dispatch_final_supervisor:false,instructions:"",reason:"Explicit fixture user resets defaults"}});assert.equal(JSON.parse(blocks(result)[0].text).dispatch_final_supervisor,false);
 await command("Page.reload");await until(async()=>await evaluate("document.getElementById('f-client_supervision.dispatch_final_supervisor')?.checked === false && document.getElementById('f-client_supervision.instructions')?.value === ''"),"MCP policy displayed by UI");
 for(const width of [1440,390])for(const theme of ["light","dark"]){await command("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:width===390});await evaluate(`localStorage.setItem('sy-theme',${JSON.stringify(theme)});document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});document.getElementById('client-supervision').scrollIntoView()`);await delay(250);assert(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"));const image=await command("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});writeFileSync(path.join(screenshots,`policy-${width}-${theme}.png`),Buffer.from(image.data,"base64"));}
 const after=YAML.parse(readFileSync(config,"utf8"));delete after.client_supervision;assert.deepEqual(after,before);assert(readFileSync(config,"utf8").includes("# preserved policy fixture comment"));assert.equal(sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get().n,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,port,cdpPort,panelPid:server.pid,chromePid:chrome.pid,config,screenshots,checks:"production UI save/reload, default final dispatch off/project dispatch permission toggle, custom text, MCP existing-connection UI-originated update once, MCP reset reflected in UI, invalid API400, unrelated config/comment preservation, zero model calls,4desktop/phone light/dark screenshots"},null,2));
}finally{
 await client.close().catch(()=>{});if(ws?.readyState===WebSocket.OPEN){await command("Browser.close").catch(()=>{});ws.close();}
 for(const child of [chrome,server])if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await until(()=>child.exitCode!==null||child.signalCode!==null,"owned child stop",10000);}
 await sy.close();const resolved=path.resolve(fixture);assert(resolved.startsWith(path.resolve(demo)+path.sep+"client-supervision-"));rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
