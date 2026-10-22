#!/usr/bin/env node
// Production demo-only Labs HTTP/browser acceptance. Owns and stops every process it starts.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { insights, loadConfig, Switchyard, LabSupervisorLease } from "switchyard-router";
const exec = promisify(execFile);
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(app, ".demo");
const config = path.join(demo, "switchyard.config.yaml");
const cfg = loadConfig(config);
assert(path.resolve(cfg.storageDir).startsWith(demo + path.sep));
assert(path.resolve(path.dirname(config), cfg.brain.path).startsWith(demo + path.sep), "Demo brain must stay in .demo");
const sy = new Switchyard(cfg, { worker: false });
for (const project of sy.projects.list()) for (const repo of Object.values(project.repositoryPaths)) assert(path.resolve(repo.path).startsWith(demo + path.sep), "Demo repositories must stay in .demo");
const modelRequestsBefore = sy.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get().n;
const routerCli = path.resolve(app, "../../packages/router/dist/cli.js");
const require = createRequire(import.meta.url);
const port = Number(process.argv[2] ?? 4496), cdpPort = Number(process.argv[3] ?? 9369);
assert(port !== 4477 && port >= 1024 && cdpPort >= 1024);
const base = `http://127.0.0.1:${port}`;
const chromePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(p => p && existsSync(p));
assert(chromePath, "Headless Chrome/Edge is required");
mkdirSync(path.join(demo, "labs-screenshots"), { recursive: true });
const profile = mkdtempSync(path.join(demo, "labs-browser-"));
let server, chrome, ws, startedSupervisor = false, createdName = null;
let fixturePorts = {}, fixturePids = [];
let n = 0; const pending = new Map(); const browserErrors = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(150); } throw new Error(`Timed out: ${label}`); }
async function request(route, method = "GET", body, status = 200) {
  const r = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const raw = await r.text(); assert.equal(r.status, status, `${method} ${route}: ${raw.slice(0, 500)}`);
  return JSON.parse(raw);
}
function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++n; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000); pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitOperation(name, id) { let last; await until(async () => { last = await request(`/api/labs/${name}?project=demo`); const op = last.operations.find(o => o.id === id); if (op?.state === "failed") throw new Error(`${op.errorCode}: ${op.errorMessage}`); return op?.state === "completed"; }, `operation ${id}`); return last; }
async function action(name, body) { startedSupervisor = true; const out = await request(`/api/labs/${name}?project=demo`, "POST", body); assert(["pending", "running", "completed"].includes(out.operation.state)); assert(!("result" in out.operation)); return waitOperation(name, out.operation.id); }
try {
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: app, env: { ...process.env, SWITCHYARD_CONFIG: config, SWITCHYARD_PANEL_TOKEN: "", SWITCHYARD_PROJECT: "" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let serverOutput = ""; server.stdout.on("data", d => { serverOutput += d; }); server.stderr.on("data", d => { serverOutput += d; });
  await until(async () => { try { return (await fetch(base + "/api/labs?project=demo")).ok; } catch { if ((server.exitCode !== null || server.signalCode !== null)) throw new Error(serverOutput); return false; } }, "production panel");
  for (const route of ["/p/demo", "/p/demo/jobs", "/p/demo/settings?tab=labs", "/p/demo/labs", "/p/demo/labs/calculator-preview", "/p/demo/labs/validation-fix"]) {
    const r = await fetch(base + route); assert.equal(r.status, 200, route);
  }
  const metadataFreeTask = sy.db.prepare("SELECT id FROM tasks WHERE project_id = 'demo' AND profile != 'supervise'").all().map(row => ({ id: row.id, detail: insights.taskDetail(sy, row.id) })).find(({ detail: d }) => d && !d.contract && !d.verification && !d.importance && !d.contractError);
  assert(metadataFreeTask, "Demo must contain a task with no contract/verification metadata");
  const verificationHtml = await (await fetch(base + `/p/demo/tasks/${metadataFreeTask.id}?tab=verification`)).text();
  assert(verificationHtml.includes("Contract and verification") && verificationHtml.includes("No contract yet."), "Verification tab must explain missing metadata instead of rendering blank");
  const list = await request("/api/labs?project=demo"); assert(list.labs.length >= 2);
  const detail = await request("/api/labs/calculator-preview?project=demo"); assert(detail.status.checks.some(c => c.exitCode === 0));
  const publicText = JSON.stringify(detail); assert(!/"(?:token|env|recipe|owner_id)":/.test(publicText), "runtime secrets leaked");
  assert((await request("/api/labs/calculator-preview/logs?project=demo&service=web")).log.includes("Demo lab ready"));
  const promotionOp = (await request("/api/labs/calculator-preview?project=demo")).operations.find(op => op.kind === "promote" && op.state === "completed");
  assert(promotionOp, "Seed must retain real reviewed promotion");
  const evidence = await request(`/api/labs/calculator-preview?project=demo&operationId=${encodeURIComponent(promotionOp.id)}`);
  assert.equal(evidence.state, "prepared"); assert(evidence.manualCommands.some(command => command.includes("git"))); assert(Object.values(evidence.heads).every(sha => /^[a-f0-9]{40}$/.test(sha)));
  await request(`/api/labs/calculator-preview?project=storefront&operationId=${encodeURIComponent(promotionOp.id)}`, "GET", undefined, 404);

  await request("/api/labs/calculator-preview?project=storefront", "GET", undefined, 404);
  await request("/api/labs/calculator-preview?project=storefront", "POST", { action: "stop" }, 404);
  await request("/api/labs/calculator-preview?project=demo", "POST", { action: "promote", reason: "" }, 400);
  await request("/api/labs/new-fixture?project=legacy-billing", "POST", { action: "create" }, 409);
  await request("/api/labs/recipe?project=demo", "PUT", { recipe: { services: { broken: { repo: "foreign", command: "node --version" } } }, promotion: "manual", maxActive: null }, 400);
  const recipe = await request("/api/labs/recipe?project=demo"); assert(!("env" in recipe.recipe));
  await request("/api/labs/recipe?project=demo", "PUT", { recipe: recipe.recipe, promotion: recipe.promotion, maxActive: recipe.maxActive });
  createdName = `panel-check-${Date.now().toString(36)}`; startedSupervisor = true;
  const created = await request("/api/labs?project=demo", "POST", { name: createdName, goal: "Production panel acceptance fixture" });
  const createdStatus = await waitOperation(createdName, created.operation.id); fixturePorts = createdStatus.status.lab.ports;
  const startedStatus = await action(createdName, { action: "start" }); fixturePids.push(...startedStatus.status.services.map(s=>s.pid).filter(Boolean));
  await action(createdName, { action: "check", check: "health" });
  const restartedStatus = await action(createdName, { action: "restart", service: "web" }); fixturePids.push(...restartedStatus.status.services.map(s=>s.pid).filter(Boolean));
  await action(createdName, { action: "stop" });
  await action(createdName, { action: "refresh" });
  await action(createdName, { action: "destroy" }); createdName = null;
  const job = await request("/api/jobs", "POST", { project: "demo", goal: "Fixture lab binding, no model worker", repositories: ["core"], acceptanceCriteria: [], checks: [], lab: "calculator-preview" });
  assert.equal(sy.tasks.get(job.job.taskId).spec.lab, "calculator-preview"); sy.cancelTasks([job.job.taskId], "demo");
  assert.equal(sy.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get().n, modelRequestsBefore, "Labs controls must not execute model work");
  chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; } }, "headless browser");
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(base)}`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const waiter = pending.get(m.id); if (waiter) { pending.delete(m.id); m.error ? waiter.reject(new Error(JSON.stringify(m.error))) : waiter.resolve(m.result); } } else if (m.method === "Runtime.exceptionThrown") browserErrors.push(m.params.exceptionDetails.text); };
  await command("Page.enable"); await command("Runtime.enable");
  const metricJob = sy.db.prepare("SELECT id FROM tasks WHERE project_id = 'demo' AND profile = 'supervise'").all().find(row => (insights.jobMetrics(sy, row.id)?.tasks.agents ?? 0) > 1);
  assert(metricJob, "Seeded multi-agent job is required for tooltip regression");
  const visibleTips = "Array.from(document.querySelectorAll('[role=tooltip]')).filter(e=>getComputedStyle(e).display!=='none' && e.getBoundingClientRect().width>0).map(e=>e.textContent.trim())";
  const move = (x, y) => command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const width of [1440, 390]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    await command("Page.navigate", { url: base + `/p/demo/jobs/${metricJob.id}?tab=team` });
    await until(async () => await evaluate("Array.from(document.querySelectorAll('summary')).some(e=>e.textContent.includes('Team metrics'))"), "Team metrics disclosure");
    const summary = await evaluate("(()=>{const s=Array.from(document.querySelectorAll('summary')).find(e=>e.textContent.includes('Team metrics'));s.scrollIntoView({block:'center'});const r=s.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await command("Input.dispatchMouseEvent", { type: "mousePressed", x: summary.x, y: summary.y, button: "left", clickCount: 1 });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: summary.x, y: summary.y, button: "left", clickCount: 1 });
    await evaluate("document.activeElement?.blur?.()");
    const target = await evaluate("(()=>{window.__metrics=Array.from(document.querySelectorAll('details')).find(e=>e.querySelector('summary')?.textContent.includes('Team metrics'));window.__tipButton=window.__metrics.querySelector('[role=tooltip]').parentElement.querySelector('button');window.__tipButton.scrollIntoView({block:'center'});const r=window.__tipButton.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,text:window.__tipButton.parentElement.querySelector('[role=tooltip]').textContent.trim()}})()");
    const away = await evaluate("(()=>{const r=window.__metrics.getBoundingClientRect();return {x:r.right-12,y:Math.max(100,Math.min(innerHeight-20,r.top+60))}})()");
    await move(away.x, away.y); await delay(100);
    assert.deepEqual(await evaluate(visibleTips), [], "Hovering Team metrics container must not open every help tip");
    if (width === 1440) {
      await move(target.x, target.y); await delay(100);
      assert.deepEqual(await evaluate(visibleTips), [target.text], "Only hovered help tip should open");
      await move(away.x, away.y); await delay(100); assert.deepEqual(await evaluate(visibleTips), []);
    }
    await evaluate("(()=>{const a=Array.from(document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')).filter(e=>e.getClientRects().length && !e.disabled && e.tabIndex>=0);a[a.indexOf(window.__tipButton)-1].focus()})()");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await delay(100);
    assert(await evaluate("document.activeElement === window.__tipButton"), "Keyboard Tab must focus selected help button");
    assert.deepEqual(await evaluate(visibleTips), [target.text], "Only keyboard-focused help tip should open");
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), `Team metrics tooltip overflows at ${width}`);
    const metricsShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path.join(demo, "labs-screenshots", `metrics-${width}-focus.png`), Buffer.from(metricsShot.data, "base64"));
    await evaluate("document.activeElement.blur()"); await move(away.x, away.y); await delay(100);
    assert.deepEqual(await evaluate(visibleTips), [], "Leave and blur must close help tips");
  }

  await command("Page.navigate", { url: base + "/p/demo/labs/calculator-preview" });
  await until(async () => await evaluate("document.querySelector('[data-lab-state]')?.getAttribute('data-lab-state') === 'stopped'"), "initial lab page");
  await action("calculator-preview", { action: "start" });
  await until(async () => await evaluate("document.querySelector('[data-lab-state]')?.getAttribute('data-lab-state') === 'running'"), "live lab running refresh", 20000);
  await action("calculator-preview", { action: "stop" });
  await until(async () => await evaluate("document.querySelector('[data-lab-state]')?.getAttribute('data-lab-state') === 'stopped'"), "live lab stopped refresh", 20000);
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
    for (const [label, route] of [["labs", "/p/demo/labs"], ["detail", "/p/demo/labs/calculator-preview"], ["recipe", "/p/demo/settings?tab=labs"], ["jobs", "/p/demo/jobs"]]) {
      await command("Page.navigate", { url: base + route });
      await until(async () => await evaluate(`document.readyState === 'complete' && location.href === ${JSON.stringify(base + route)}`), "page load");
      await evaluate(`localStorage.setItem('sy-theme',${JSON.stringify(theme)});document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)})`);
      await delay(350);
      if (label === "detail" && width === 1440 && theme === "light") {
        await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Inspect promotion evidence').click()");
        await until(async () => await evaluate("document.body.textContent.includes('Manual promotion instructions.')"), "manual promotion UI evidence");
        assert(await evaluate("Array.from(document.querySelectorAll('pre')).some(p=>p.textContent.includes('git'))"));
      }
      const metrics = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,title:document.title})");
      assert(metrics.scroll <= metrics.width + 1, `${label} overflows at ${width}`);
      if (label === "jobs") assert(await evaluate("Array.from(document.querySelectorAll('select option')).some(o=>o.value==='calculator-preview')"));
      const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(path.join(demo, "labs-screenshots", `${label}-${width}-${theme}.png`), Buffer.from(shot.data, "base64"));
    }
  }
  assert.deepEqual(browserErrors, []);
  assert.equal(sy.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get().n, modelRequestsBefore);
  console.log(JSON.stringify({ ok: true, productionPort: port, cdpPort, panelPid: server.pid, chromePid: chrome.pid, supervisorPid: new LabSupervisorLease(sy.db, config).read()?.pid ?? null, fixturePorts, fixturePids, config, screenshots: 18, root: path.join(demo, "labs-screenshots"), checks: "pages, missing-metadata verification explanation, API/control queue, recipe, scoped denials, archive, lab job binding, no model requests, live refresh, no runtime secrets, light/dark desktop/phone" }, null, 2));
} finally {
  await sy.labs.stop("demo", "calculator-preview").catch(() => {});
  if (createdName) {
    await until(() => !sy.db.prepare("SELECT 1 FROM lab_operations WHERE project_id=? AND lab_name=? AND state IN ('pending','running')").get("demo", createdName), "fixture operation settles before cleanup", 30000).catch(() => {});
    await sy.labs.stop("demo", createdName).catch(() => {});
    await sy.labs.destroy("demo", createdName).catch(e => console.error("fixture cleanup failed", e.message));
  }
  if (startedSupervisor) await exec(process.execPath, [routerCli, "labs", "supervisor-stop", "--config", config], { windowsHide: true, env: { ...process.env, SWITCHYARD_PROJECT: "" } }).catch(e => console.error("supervisor cleanup failed", e.message));
  if (ws?.readyState === WebSocket.OPEN) { await command("Browser.close").catch(() => {}); ws.close(); }
  if (chrome && (chrome.exitCode === null && chrome.signalCode === null)) await until(() => (chrome.exitCode !== null || chrome.signalCode !== null), "browser stop", 5000).catch(() => chrome.kill());
  if (server && (server.exitCode === null && server.signalCode === null)) { server.kill(); await until(() => (server.exitCode !== null || server.signalCode !== null), "panel stop", 10000); }
  await sy.close();
  if (path.resolve(profile).startsWith(path.resolve(demo) + path.sep + "labs-browser-")) rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
