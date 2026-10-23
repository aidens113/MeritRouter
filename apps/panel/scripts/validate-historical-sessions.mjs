#!/usr/bin/env node
// Actual seeded demo history, production Next, owned headless Chrome. No model worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { insights, loadConfig, MeritRouter } from "meritrouter";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(app, ".demo"), config = path.join(demo, "meritrouter.config.yaml");
const cfg = loadConfig(config); assert(path.resolve(cfg.storageDir).startsWith(demo + path.sep));
assert(path.resolve(path.dirname(config), cfg.brain.path).startsWith(demo + path.sep));
const sy = new MeritRouter(cfg, { worker: false });
for (const project of sy.projects.list()) for (const repo of Object.values(project.repositoryPaths)) assert(path.resolve(repo.path).startsWith(demo + path.sep));
const port = 4497, cdpPort = 9373, base = `http://127.0.0.1:${port}`;
const require = createRequire(import.meta.url), profile = mkdtempSync(path.join(demo, "historical-session-browser-"));
const screenshots = path.join(demo, "historical-session-screenshots"); mkdirSync(screenshots, { recursive: true });
let server, chrome, ws; let counter = 0; const pending = new Map(), browserErrors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(100); } throw new Error(`Timed out: ${label}`); }
function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++counter, timer = setTimeout(() => reject(new Error(`CDP ${method}`)), 45000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result?.value; }
async function http(route, status = 200) { const result = await fetch(base + route); assert.equal(result.status, status, `${route}: ${await result.clone().text()}`); return result.text(); }

const stamp = Date.now().toString(36), execution = `scope-exec-${stamp}`, request = `scope-request-${stamp}`;
let recorder;
try {
 const own = sy.db.prepare("SELECT id FROM tasks WHERE project_id='demo' LIMIT 1").get();
 const foreign = sy.db.prepare("SELECT id FROM tasks WHERE project_id='storefront' LIMIT 1").get();
 assert(own && foreign);
 const normal = sy.db.prepare("SELECT id FROM sessions WHERE project_id='demo' ORDER BY created_at DESC LIMIT 100").all().map(r=>({id:r.id,d:insights.sessionDetail(sy,r.id,{project:'demo'})})).find(r=>r.d?.timelineUnavailable===null && r.d.events.some(e=>e.type==='model_request'));
 assert(normal,'seeded same-project timeline');
 sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES (?,'batch','summarize','completed',1)").run(execution);
 for (const task of [own.id,foreign.id]) sy.db.prepare('INSERT INTO execution_members(execution_id,task_id,item_id) VALUES (?,?,?)').run(execution,task,task);
 sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES (?,?,'classification','fixture/model','failed',1,10,10,'demo')").run(request,execution);
 for(const task of [own.id,foreign.id])sy.db.prepare('INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES (?,?,1,1)').run(request,task);
 recorder=sy.sessions.create({taskId:own.id,role:'classifier',agentLabel:'classifier:historical-scope-fixture'});
 recorder.note('shared classification request',{executionId:execution,members:[own.id,foreign.id].map(taskId=>({taskId,itemId:taskId}))});
 recorder.syncMessages([{role:'user',content:'FOREIGN_HISTORICAL_SENTINEL joined classifier goals'}]);
 recorder.modelRequest({executionId:execution,purpose:'classification',chat:{messages:[],max_tokens:100}});
 recorder.append('model_error',{executionId:execution,message:'FOREIGN_HISTORICAL_SENTINEL provider error',code:null,status:null,attempts:[]});
 recorder.end('failed','FOREIGN_HISTORICAL_SENTINEL stop');
 sy.db.prepare('DELETE FROM request_charges WHERE request_id=? AND task_id=?').run(request,foreign.id);
 sy.db.prepare('DELETE FROM execution_members WHERE execution_id=? AND task_id=?').run(execution,foreign.id);
 const count=sy.db.prepare('SELECT COUNT(*) n FROM model_requests').get().n;
 server = spawn(process.execPath, [require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:app,env:{...process.env,MERITROUTER_CONFIG:config,MERITROUTER_PROJECT:'',MERITROUTER_PANEL_TOKEN:''},stdio:'ignore',windowsHide:true});
 await until(async()=>{try{return(await fetch(base+'/p/demo/sessions')).ok;}catch{return false;}},'production server');
 for(const query of ['', '?after=2','?after=999','?tab=details','?tab=requests']){
   const html=await http(`/p/demo/sessions/${recorder.id}${query}`);assert(html.includes('Historical timeline unavailable'));assert(!html.includes('FOREIGN_HISTORICAL_SENTINEL'));assert(!html.includes(foreign.id));
 }
 const api=JSON.parse(await http(`/api/sessions/${recorder.id}?after=2`));assert.equal(api.events.length,0);assert(api.timelineUnavailable);assert(!JSON.stringify(api).includes('FOREIGN_HISTORICAL_SENTINEL'));
 await http(`/p/storefront/sessions/${recorder.id}`,404);
 const good=await http(`/p/demo/sessions/${normal.id}`);assert(!good.includes('Historical timeline unavailable'));
 const chromePath=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&existsSync(p));assert(chromePath);
 chrome=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
 let target;await until(async()=>{try{target=(await(await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t=>t.type==='page'&&t.url==='about:blank');return !!target;}catch{return false;}},'browser');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')browserErrors.push(m.params);});
 await command('Page.enable');await command('Runtime.enable');
 for(const width of [1440,390])for(const theme of ['light','dark'])for(const [kind,id] of [['blocked',recorder.id],['same-project',normal.id]]){
  await command('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});
  await command('Page.navigate',{url:base+`/p/demo/sessions/${id}`});
  await until(async()=>await evaluate(`location.pathname.endsWith(${JSON.stringify(id)}) && !!document.body && document.body.textContent.includes('Session')`),'session render');
  await evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)})`);await delay(250);
  if(kind==='blocked')assert(await evaluate("document.body.textContent.includes('Historical timeline unavailable') && !document.body.textContent.includes('FOREIGN_HISTORICAL_SENTINEL')"));
  if(kind==='blocked'){await evaluate("Array.from(document.querySelectorAll('div')).find(h=>h.textContent==='Historical timeline unavailable')?.scrollIntoView();window.scrollBy(0,-80)");await delay(150);}
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  const capture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(path.join(screenshots,`session-${width}-${theme}-${kind}.png`),Buffer.from(capture.data,'base64'));
 }
 assert.deepEqual(browserErrors,[]);assert.equal(sy.db.prepare('SELECT COUNT(*) n FROM model_requests').get().n,count);
 console.log(JSON.stringify({ok:true,port,cdpPort,panelPid:server.pid,chromePid:chrome.pid,config,normal:normal.id,blocked:recorder.id,screenshots,screenshotCount:8,checks:'mixed failed cohort withheld page/API/all tabs/paging; wrong-project404; same-project timeline; no browser errors/overflow/provider calls'},null,2));
}finally{
 if(ws?.readyState===WebSocket.OPEN){await command('Browser.close').catch(()=>{});ws.close();}
 for(const child of [chrome,server])if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await until(()=>child.exitCode!==null||child.signalCode!==null,'owned exit',10000);}
 if(recorder){sy.db.prepare('DELETE FROM session_events WHERE session_id=?').run(recorder.id);sy.db.prepare('DELETE FROM sessions WHERE id=?').run(recorder.id);rmSync(recorder.logPath,{force:true});}
 sy.db.prepare('DELETE FROM request_charges WHERE request_id=?').run(request);sy.db.prepare('DELETE FROM model_requests WHERE id=?').run(request);sy.db.prepare('DELETE FROM execution_members WHERE execution_id=?').run(execution);sy.db.prepare('DELETE FROM executions WHERE id=?').run(execution);
 await sy.close();assert(path.resolve(profile).startsWith(path.resolve(demo)+path.sep+'historical-session-browser-'));rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
