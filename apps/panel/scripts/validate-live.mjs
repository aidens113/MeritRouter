#!/usr/bin/env node
// Browser acceptance against the generated demo only. Start a production demo panel on 4489
// and headless Chrome with --remote-debugging-port=9335 first. Never uses real provider calls.
// pnpm --filter switchyard-panel validate:live [http://127.0.0.1:4489] [9335]
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { insights, loadConfig, Switchyard } from "switchyard-router";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, "../.demo");
const base = z.string().url().parse(process.argv[2] ?? "http://127.0.0.1:4489");
const parsedUrl = new URL(base);
assert(["127.0.0.1", "localhost"].includes(parsedUrl.hostname) && parsedUrl.port !== "4477", "Use a spare loopback demo port, never the live panel");
const port = z.coerce.number().int().min(1024).max(65535).parse(process.argv[3] ?? 9335);
const cfg = loadConfig(path.join(demo, "switchyard.config.yaml"));
assert(path.resolve(cfg.storageDir).startsWith(demo + path.sep), "Demo storage must remain under .demo");
const sy = new Switchyard(cfg, { worker: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let ws;
let target;
let taskBefore;
let brainBefore;
let brainChanged = false;
const brainPath = "global/glossary.md";
const requestId = `r_panel_live_${Date.now().toString(36)}`;
let requestInserted = false;
const pending = new Map();
let nextId = 0;
const events = [];

function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
async function waitFor(expression, timeout = 10000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (await evaluate(`!!(${expression})`)) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function navigate(route) {
  await command("Page.navigate", { url: new URL(route, base).href });
  await waitFor("document.readyState === 'complete'");
  await waitFor("document.querySelector('[data-live-state=live]')");
  await evaluate("window.__panelAcceptanceMarker = 'preserved'");
  await sleep(1000); // Let initial navigation/prefetch settle before observing mutations.
}
async function observed(kind, expression, mutate) {
  await mutate();
  const start = performance.now();
  await waitFor(expression);
  const elapsedMs = Math.round(performance.now() - start);
  assert.equal(await evaluate("window.__panelAcceptanceMarker"), "preserved", "Live update must not reload the document");
  assert(elapsedMs < 2500, `${kind} DOM update took ${elapsedMs} ms (expected about 2 seconds)`);
  results.push({ kind, elapsedMs, documentPreserved: true });
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: "PUT" });
  target = z.object({ id: z.string(), webSocketDebuggerUrl: z.string().url() }).parse(await response.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (waiter) message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    } else events.push(message);
  };
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Network.enable");

  taskBefore = z.object({ id: z.string(), state_reason: z.string().nullable(), updated_at: z.number() }).parse(
    sy.db.prepare("SELECT id, state_reason, updated_at FROM tasks WHERE project_id = 'demo' AND state = 'interrupted' AND profile != 'supervise' LIMIT 1").get(),
  );
  await navigate(`/p/demo/tasks/${encodeURIComponent(taskBefore.id)}?tab=sessions`);
  await evaluate("document.querySelector('details')?.setAttribute('open', ''); window.scrollTo(0, 120)");
  const marker = `Live acceptance ${Date.now()}`;
  await observed("task", `document.body.innerText.includes(${JSON.stringify(marker)})`, () => {
    sy.db.prepare("UPDATE tasks SET state_reason = ?, updated_at = ? WHERE id = ?").run(marker, Date.now(), taskBefore.id);
  });
  assert(await evaluate("document.querySelector('details')?.open"), "Open disclosure must survive refresh");

  // The request page subscribes to requests, so task invalidation cannot satisfy this check.
  const source = z.object({ id: z.string() }).parse(sy.db.prepare("SELECT id FROM model_requests WHERE project_id = 'demo' AND status = 'succeeded' LIMIT 1").get());
  const columns = z.array(z.object({ name: z.string().regex(/^[a-z_]+$/) })).parse(sy.db.prepare("PRAGMA table_info(model_requests)").all()).map(row => row.name);
  const replacements = new Map([["id", requestId], ["reserved_at", Date.now()], ["finished_at", Date.now()]]);
  const values = [];
  const expressions = columns.map(name => {
    if (!replacements.has(name)) return name;
    values.push(replacements.get(name));
    return "?";
  });
  await navigate("/p/demo/requests");
  const href = `/p/demo/requests/${requestId}`;
  await observed("new-model-request", `document.querySelector(${JSON.stringify(`a[href="${href}"]`)})`, () => {
    sy.db.prepare(`INSERT INTO model_requests (${columns.join(",")}) SELECT ${expressions.join(",")} FROM model_requests WHERE id = ?`).run(...values, source.id);
    requestInserted = true;
  });

  // Change a real tracked brain file through the public service, independently of task/request rows.
  brainBefore = insights.brainRead(sy, brainPath, "demo").content;
  await navigate(`/p/demo/brain?path=${encodeURIComponent(brainPath)}`);
  const brainMarker = `Panel brain live evidence ${Date.now()}`;
  await observed("brain-commit", `document.body.innerText.includes(${JSON.stringify(brainMarker)})`, async () => {
    brainChanged = true;
    await insights.brainWrite(sy, brainPath, `${brainBefore.trimEnd()}\n\n${brainMarker}\n`, "demo");
  });
  const refreshes = () => events.filter(event => event.method === "Network.requestWillBeSent" && event.params.request.url.includes("_rsc=") && !Object.keys(event.params.request.headers).some(key => key.toLowerCase() === "next-router-prefetch")).length;
  await sleep(1000);
  const before = refreshes();
  await sleep(2500);
  assert.equal(refreshes() - before, 0, "Quiet page must not poll server components");
  results.push({ kind: "quiet-page", refreshes: 0, durationMs: 2500 });
  assert.equal(events.filter(event => event.method === "Runtime.exceptionThrown").length, 0, "Browser exceptions must be inspected");
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  if (taskBefore) sy.db.prepare("UPDATE tasks SET state_reason = ?, updated_at = ? WHERE id = ?").run(taskBefore.state_reason, taskBefore.updated_at, taskBefore.id);
  if (requestInserted) sy.db.prepare("DELETE FROM model_requests WHERE id = ?").run(requestId);
  if (brainChanged) await insights.brainWrite(sy, brainPath, brainBefore, "demo");
  await sy.close();
  ws?.close();
  if (target) await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
}
