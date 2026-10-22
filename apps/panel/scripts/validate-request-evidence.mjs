#!/usr/bin/env node
// Actual seeded demo history, production Next, owned headless Chrome. No model worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { insights, loadConfig, Switchyard } from "switchyard-router";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(app, ".demo"), config = path.join(demo, "switchyard.config.yaml");
const cfg = loadConfig(config); assert(path.resolve(cfg.storageDir).startsWith(demo + path.sep));
assert(path.resolve(path.dirname(config), cfg.brain.path).startsWith(demo + path.sep));
const sy = new Switchyard(cfg, { worker: false });
for (const project of sy.projects.list()) for (const repo of Object.values(project.repositoryPaths)) assert(path.resolve(repo.path).startsWith(demo + path.sep));
const port = 4497, cdpPort = 9373, base = `http://127.0.0.1:${port}`;
const require = createRequire(import.meta.url), profile = mkdtempSync(path.join(demo, "request-evidence-browser-"));
const screenshots = path.join(demo, "request-evidence-screenshots"); mkdirSync(screenshots, { recursive: true });
let server, chrome, ws; let counter = 0; const pending = new Map(), browserErrors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(100); } throw new Error(`Timed out: ${label}`); }
function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++counter, timer = setTimeout(() => reject(new Error(`CDP ${method}`)), 45000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result?.value; }
async function http(route, status = 200) { const result = await fetch(base + route); assert.equal(result.status, status, `${route}: ${await result.clone().text()}`); return result.text(); }
let selected, batch, failure, captured;
try {
  const rows = sy.db.prepare("SELECT id,status FROM model_requests WHERE project_id='demo' ORDER BY reserved_at DESC LIMIT 250").all();
  for (const row of rows) {
    const evidence = insights.requestEvidence(sy, "demo", row.id);
    const capture = insights.requestDetail(sy, row.id, "demo")?.capture;
    if (!captured && capture?.input?.tools?.length && capture.availability !== "unavailable") captured = { id: row.id, capture };
    if (!selected && evidence?.exchanges.some(e => e.actions.some(a => a.file))) selected = { id: row.id, evidence };
    if (!batch && evidence?.exchanges.some(e => e.sessions.length > 1)) batch = { id: row.id, evidence };
    if (!failure && row.status === "failed" && evidence?.state === "unavailable") failure = { id: row.id, evidence };
    if (selected && batch && failure && captured) break;
  }
  assert(selected, "Seeded actual coding history must contain a recorded successful edit response");
  assert(batch, "Seeded actual shared batch exchange must be deduplicated");
  assert(failure, "Seeded failed endpoint history must explain unavailable input/output");
  assert(captured, "Seeded admitted tool request must have a normalized input capture");
  const count = sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get().n;
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: app, env: { ...process.env, SWITCHYARD_CONFIG: config, SWITCHYARD_PROJECT: "", SWITCHYARD_PANEL_TOKEN: "" }, stdio: "ignore", windowsHide: true });
  await until(async () => { try { return (await fetch(base + "/p/demo/requests")).ok; } catch { return false; } }, "production server");
  for (const id of [selected.id, batch.id, failure.id]) { const html = await http(`/p/demo/requests/${id}`); assert(html.includes("Related files and task evidence")); assert(html.includes("Usage accounting")); }
  const selectedHtml = await http(`/p/demo/requests/${selected.id}`); assert(selectedHtml.includes("Request input")); assert(selectedHtml.includes("Model response")); assert(selectedHtml.includes("Actions from this response")); assert(selectedHtml.includes("not the serialized provider HTTP body"));
  const capturedHtml = await http(`/p/demo/requests/${captured.id}`);
  assert(capturedHtml.includes("Captured request input")); assert(capturedHtml.includes("Captured observed response"));
  assert(capturedHtml.includes("Tool definitions (")); assert(capturedHtml.includes("not the raw HTTP body"));
  await http(`/p/storefront/requests/${captured.id}`, 404);
  const failedHtml = await http(`/p/demo/requests/${failure.id}`); assert(failedHtml.includes("Recorded input/output unavailable"));
  await http(`/p/storefront/requests/${selected.id}`, 404); await http(`/all/qualification/requests/${selected.id}`, 404);
  const qualification = sy.db.prepare("SELECT id FROM model_requests WHERE project_id='_qualification' ORDER BY reserved_at DESC LIMIT 1").get();
  if (qualification) await http(`/all/qualification/requests/${qualification.id}`);
  const legacy = await fetch(base + `/requests/${selected.id}`); assert.equal(legacy.status, 200); assert.equal(new URL(legacy.url).pathname, `/p/demo/requests/${selected.id}`);
  const chromePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(p => p && existsSync(p)); assert(chromePath);
  chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  let target; await until(async () => { try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === "page" && t.url === "about:blank"); return !!target; } catch { return false; } }, "browser");
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
  ws.addEventListener("message", event => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(m.error) : p?.resolve(m.result); } if (m.method === "Runtime.exceptionThrown") browserErrors.push(m.params); });
  await command("Page.enable"); await command("Runtime.enable");
  await command("Page.navigate", { url: base + "/p/demo/requests" });
  await until(async () => await evaluate("Array.from(document.querySelectorAll('a')).some(a=>a.getAttribute('href')?.startsWith('/p/demo/requests/'))"), "request navigation links");
  await delay(500);
  await evaluate("Array.from(document.querySelectorAll('a')).find(a=>a.getAttribute('href')?.startsWith('/p/demo/requests/')).click()");
  await until(async () => await evaluate("location.pathname.startsWith('/p/demo/requests/') && !!document.querySelector('[data-request-evidence]')"), "actual client navigation");
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await command("Page.navigate", { url: base + `/p/demo/requests/${selected.id}` });
    await until(async () => await evaluate(`location.pathname === ${JSON.stringify(`/p/demo/requests/${selected.id}`)} && !!document.querySelector('[data-request-evidence]')`), "detail render");
    await evaluate(`localStorage.setItem('sy-theme',${JSON.stringify(theme)});document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)})`);
    for (const section of ["input", "actions"]) {
      await evaluate((section === "input" ? "document.querySelector('[data-request-evidence]').scrollIntoView();" : "Array.from(document.querySelectorAll('h2')).find(h=>h.textContent==='Actions from this response').closest('section').scrollIntoView();") + "window.scrollBy(0,-80)"); await delay(250);
      assert(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), `${width}/${theme}/${section} page overflow`);
      assert.equal(await evaluate("window.evidenceInjected === true"), false);
      const image = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(path.join(screenshots, `request-${width}-${theme}-${section}.png`), Buffer.from(image.data, "base64"));
    }
    assert(await evaluate("document.body.textContent.includes('not attributed to this individual provider request')"));
  }
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await command("Page.navigate", { url: base + `/p/demo/requests/${captured.id}` });
    await until(async () => await evaluate("!!document.querySelector('[data-request-capture]')"), "normalized capture render");
    await evaluate(`localStorage.setItem('sy-theme',${JSON.stringify(theme)});document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});document.querySelector('[data-request-capture]').scrollIntoView();window.scrollBy(0,-80)`);
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), `${width}/${theme} capture overflow`);
    assert(await evaluate("document.querySelector('[data-request-capture]').textContent.includes('Captured observed response')"));
    const image = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path.join(screenshots, `capture-${width}-${theme}-input.png`), Buffer.from(image.data, "base64"));
    await evaluate("Array.from(document.querySelectorAll('[data-request-capture] details')).find(d=>d.querySelector('summary')?.textContent.startsWith('Tool definitions')).open=true");
    const names = await evaluate("document.querySelector('[data-request-capture]').textContent");
    for (const tool of captured.capture.input.tools) assert(names.includes(tool.name));
  }
  await command("Page.navigate", { url: base + `/p/demo/requests/${selected.id}` });
  await until(async () => await evaluate("!!document.querySelector('[data-request-evidence]')"), "related evidence navigation");
  const links = await evaluate("Array.from(document.querySelectorAll('[data-request-evidence] a')).map(a=>a.getAttribute('href')).filter(h=>h?.startsWith('/p/demo/'))");
  for (const link of [...new Set(links)].slice(0, 6)) await http(link);
  assert.deepEqual(browserErrors, []); assert.equal(sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get().n, count);
  console.log(JSON.stringify({ ok: true, port, cdpPort, panelPid: server.pid, chromePid: chrome.pid, config, selected: selected.id, batch: batch.id, unavailable: failure.id, screenshots, screenshotCount: 12, captured: captured.id, checkedLinks: [...new Set(links)].slice(0, 6), checks: "seeded exact edit response/input/parameters, batch dedup, unavailable failures, scoped404+legacy redirect, real client navigation, related task/session/commit/artifact links, bounded phone/desktop light/dark, no browser exceptions or model requests" }, null, 2));
} finally {
  if (ws?.readyState === WebSocket.OPEN) { await command("Browser.close").catch(() => {}); ws.close(); }
  for (const child of [chrome, server]) if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, "owned process exit", 10000); }
  await sy.close(); assert(path.resolve(profile).startsWith(path.resolve(demo) + path.sep + "request-evidence-browser-")); rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
