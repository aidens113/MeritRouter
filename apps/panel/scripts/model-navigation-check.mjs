#!/usr/bin/env node
// Actual browser clicks against this checkout's disposable demo only; no providers or user profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadConfig, Switchyard } from 'switchyard-router';

const panel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.join(panel, '.demo');
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:4493');
assert(base.hostname === '127.0.0.1' && base.port !== '4477', 'Use an isolated spare demo port');
const debugPort = 9343;
const cfg = loadConfig(path.join(demo, 'switchyard.config.yaml'));
assert(path.resolve(cfg.storageDir).startsWith(demo + path.sep));
const sy = new Switchyard(cfg, { worker: false });
const catalogFile = path.join(demo, 'models.yaml');
const original = readFileSync(catalogFile, 'utf8');
const originalDoc = YAML.parse(original);
const output = path.join(demo, 'model-navigation-results');
mkdirSync(output, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const errors = [];
let chrome, ws, target, sequence = 0;
const pending = new Map();
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: value => { clearTimeout(timer); reject(value); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
async function waitFor(expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(`!!(${expression})`)) return; await sleep(50); }
  throw new Error(`Browser condition timed out: ${expression}`);
}
async function navigate(route) {
  await command('Page.navigate', { url: new URL(route, base).href });
  await waitFor("document.readyState === 'complete'");
  await sleep(500);
}
async function click(expression) {
  const rect = await evaluate(`(() => {const el=${expression}; if(!el) return null; el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  assert(rect, `Missing click target ${expression}`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}
async function screenshot(name) {
  const r = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(output, name), Buffer.from(r.data, 'base64'));
}
const idLink = id => `[...document.querySelectorAll('a[href]')].find(a=>a.pathname==='/all/models/detail'&&new URL(a.href).searchParams.get('id')===${JSON.stringify(id)})`;
const missing = "document.body.innerText.includes('This page, project, task, or model does not exist.')";
try {
  const debugAlreadyUsed = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(() => true, () => false);
  assert(!debugAlreadyUsed, 'Debug port is already in use; never attach to an existing browser');
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(demo, 'model-navigation-browser')}`,
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${debugPort}/json/version`); ready = true; break; } catch { await sleep(100); } }
  assert(ready, 'Owned isolated Chrome did not start');
  target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(base.href)}`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if(p) m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params);
  };
  await command('Page.enable'); await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const selected = originalDoc.endpoints.filter(ep => ep.id.includes('/') && ep.gatewayModelId.includes('.')).slice(0, 3);
  assert(selected.length >= 2, 'Seed must include slash/dot model IDs');
  for (const ep of selected) {
    const route = `/all/models/detail?id=${encodeURIComponent(ep.id)}`;
    const response = await fetch(new URL(route, base));
    const html = await response.text();
    assert.equal(response.status, 200); assert(html.includes(ep.displayName ?? ep.gatewayModelId));
    await navigate('/all/models');
    await waitFor(idLink(ep.id));
    await evaluate("window.__modelClickMarker='preserved'");
    await click(idLink(ep.id));
    await waitFor(`document.querySelector('h1')?.innerText===${JSON.stringify(ep.displayName ?? ep.gatewayModelId)}`);
    assert.equal(await evaluate('window.__modelClickMarker'), 'preserved', 'Model click must use client navigation');
    for (const tab of ['eligibility', 'qualification', 'usage', 'controls', 'overview']) {
      await click(`document.querySelector('[data-tab="${tab}"]')`);
      await waitFor(`document.querySelector('[data-tab="${tab}"]')?.getAttribute('aria-current')==='page'`);
      assert.equal(await evaluate("new URL(location.href).searchParams.get('id')"), ep.id);
      assert.equal(await evaluate('window.__modelClickMarker'), 'preserved');
      assert.equal(await evaluate(missing), false);
    }
    results.push({ id: ep.id, directStatus: response.status, clientClick: true, preservedTabs: 5 });
  }
  await screenshot('active-model.png');
  const ep = selected[0];
  await navigate(`/all/models/detail?id=${encodeURIComponent(ep.id)}&tab=usage`);
  await waitFor("document.querySelector('[data-live-state=live]')");
  const changed = structuredClone(originalDoc);
  changed.endpoints.find(row => row.id === ep.id).displayName = 'Mutable catalog fixture title';
  writeFileSync(catalogFile, YAML.stringify(changed)); sy.catalog.bump();
  await waitFor("document.querySelector('h1')?.innerText==='Mutable catalog fixture title'");
  assert.equal(await evaluate("new URL(location.href).searchParams.get('tab')"), 'usage');
  results.push({ mutableCatalog: true, tabPreserved: 'usage' });
  const used = sy.db.prepare("SELECT id,project_id,endpoint_id FROM model_requests WHERE project_id='demo' AND endpoint_id IS NOT NULL AND status='succeeded' ORDER BY reserved_at LIMIT 100").all().find(row => originalDoc.endpoints.some(ep => ep.id === row.endpoint_id));
  assert(used, 'Seed must include a historical request model');
  const removed = structuredClone(originalDoc);
  removed.endpoints = removed.endpoints.filter(ep => ep.id !== used.endpoint_id);
  writeFileSync(catalogFile, YAML.stringify(removed)); sy.catalog.bump();
  await navigate(`/p/${encodeURIComponent(used.project_id)}/requests/${encodeURIComponent(used.id)}`);
  await waitFor(idLink(used.endpoint_id));
  await click(idLink(used.endpoint_id));
  await waitFor(`new URL(location.href).searchParams.get('id')===${JSON.stringify(used.endpoint_id)}`);
  await waitFor("document.body.innerText.includes('No longer in the current catalog')");
  const historyMissing = await evaluate(missing);
  assert.equal(historyMissing, false, 'A model with recorded requests must retain its history detail page');
  assert.equal(await evaluate("document.querySelector('[data-tab=controls]') !== null"), false);
  assert.equal(await evaluate("document.querySelector('[data-tab=eligibility]') !== null"), false);
  assert.equal(await evaluate("document.querySelector('[data-tab=qualification]') !== null"), false);
  const latest = sy.db.prepare('SELECT served_provider,served_model FROM model_requests WHERE endpoint_id=? ORDER BY reserved_at DESC LIMIT 1').get(used.endpoint_id);
  if (latest.served_provider) assert.equal(await evaluate("[...document.querySelectorAll('dt')].find(dt=>dt.innerText==='Provider reported serving')?.nextElementSibling?.innerText"), latest.served_provider);
  if (latest.served_model) assert.equal(await evaluate("[...document.querySelectorAll('dt')].find(dt=>dt.innerText==='Model reported serving')?.nextElementSibling?.innerText"), latest.served_model);
  await click("document.querySelector('[data-tab=usage]')");
  await waitFor("document.querySelector('[data-tab=usage]')?.getAttribute('aria-current')==='page'");
  assert.equal(await evaluate("new URL(location.href).searchParams.get('id')"), used.endpoint_id);
  await click("document.querySelector('[data-tab=overview]')");
  await waitFor("document.querySelector('[data-tab=overview]')?.getAttribute('aria-current')==='page'");
  const historicalDirect = await fetch(new URL(`/all/models/detail?id=${encodeURIComponent(used.endpoint_id)}`, base));
  const historicalHtml = await historicalDirect.text();
  assert.equal(historicalDirect.status, 200);
  assert(historicalHtml.includes('No longer in the current catalog'));
  await navigate(`/all/models/detail?id=${encodeURIComponent(used.endpoint_id)}`);
  await waitFor("document.body.innerText.includes('No longer in the current catalog')");
  const directMissing = await evaluate(missing);
  assert.equal(directMissing, false);
  results.push({ historicalModelId: used.endpoint_id, sourceRequest: used.id, historicalClientNotFound: historyMissing, historicalDirectStatus: historicalDirect.status, historicalDirectNotFound: directMissing, recordedServedProvider: latest.served_provider, recordedServedModel: latest.served_model });
  await screenshot('historical-model.png');
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await screenshot(`historical-model-${theme}-desktop.png`);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await screenshot(`historical-model-${theme}-phone.png`);
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Historical page must not overflow horizontally');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  }
  await navigate('/all/models/detail?id=unknown%2Fmissing.model.fixture');
  await waitFor(missing);
  const unknownStatus = (await fetch(new URL('/all/models/detail?id=unknown%2Fmissing.model.fixture', base))).status;
  const missingIdStatus = (await fetch(new URL('/all/models/detail', base))).status;
  assert.equal(unknownStatus, 404); assert.equal(missingIdStatus, 404);
  results.push({ unknownModelNotFound: true, unknownStatus, missingIdStatus });
  const addedId = 'lab/vendor.dot/minimax.fixture:free';
  await navigate(`/all/models/detail?id=${encodeURIComponent(addedId)}`);
  await waitFor(missing);
  const added = structuredClone(originalDoc);
  added.endpoints.push({ ...added.endpoints[0], id: addedId, providerId: 'lab', gatewayModelId: 'vendor.dot/minimax.fixture:free', displayName: 'Added MiniMax fixture' });
  writeFileSync(catalogFile, YAML.stringify(added)); sy.catalog.bump();
  await navigate('/all/models'); await waitFor(idLink(addedId));
  await evaluate("window.__modelClickMarker='preserved'");
  await click(idLink(addedId));
  await waitFor("document.querySelector('h1')?.innerText==='Added MiniMax fixture'");
  assert.equal(await evaluate('window.__modelClickMarker'), 'preserved');
  assert.equal(await evaluate(missing), false);
  results.push({ previouslyUnknownAddedModel: addedId, clientClick: true, noStale404: true });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, browserExceptions: errors }, null, 2));
  console.log(JSON.stringify({ results, browserExceptions: errors, output }, null, 2));
} finally {
  writeFileSync(catalogFile, original); sy.catalog.bump();
  await sy.close();
  if (ws?.readyState === 1) { await command('Browser.close').catch(() => undefined); ws.close(); }
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    await Promise.race([new Promise(r => chrome.once('exit', r)), sleep(2000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
      else chrome.kill('SIGKILL');
    }
  }
}
