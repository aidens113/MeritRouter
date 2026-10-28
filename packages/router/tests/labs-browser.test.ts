import { afterEach, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { baseConfig, makeEnv, type Env } from "./helpers.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { processAlive } from "../src/labs/process-ownership.js";
import { portAvailable } from "../src/labs/ports.js";
import { BrowserCheckSchema } from "../src/labs/browser-schema.js";
const chrome = process.env.MERITROUTER_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let env: Env | undefined;
let db: Db | undefined;
let manager: LabManager | undefined;
let trap: Server | undefined;
let hits = 0;
let connections = 0;
// The test's state is taken into locals so a slow teardown never touches the next test's, and
// every step runs even if closing the manager fails. A verified Windows Lab stop takes several
// PowerShell round trips, far beyond vitest's 10 s default hook timeout on a loaded host.
afterEach(async () => {
  const owned = manager, store = db, fixture = env, server = trap;
  manager = undefined; db = undefined; env = undefined; trap = undefined;
  let failure: unknown;
  try { await owned?.close(); } catch (error) { failure = error; }
  store?.close();
  fixture?.cleanup();
  if (server)
    await new Promise<void>(resolve => server.close(() => resolve()));
  if (failure) throw failure;
}, 120_000);
async function setup(checks: Record<string, unknown>) {
  hits = 0;
  connections = 0;
  trap = createServer((_req, res) => {
    hits++;
    res.end('foreign');
  });
  trap.on('connection', () => connections++);
  trap.on('upgrade', (_req, socket) => {
    hits++;
    socket.destroy();
  });
  await new Promise<void>(resolve => trap!.listen(0, '127.0.0.1', resolve));
  const address = trap.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture failed');
  const config = baseConfig({ repositories: {}, brain: { path: 'brain', project: 'alpha' }, labs: { port_range: [57000, 57500] }, projects: { alpha: { repositories: { app: { path: 'repo' } }, lab: { ports: ['web'], env: { PORT: '{port.web}', TRAP_PORT: String(address.port) }, services: { web: { repo: 'app', command: JSON.stringify(process.execPath) + ' server.cjs', ready: { http: 'http://127.0.0.1:{port.web}/' } } }, checks } } } });
  env = makeEnv({ config, files: { 'server.cjs': readFileSync(fileURLToPath(new URL('./fixtures/lab-browser-server.cjs', import.meta.url)), 'utf8') } });
  db = openDatabase(env.cfg.storageDir);
  const registry = new ProjectRegistry(env.cfg);
  manager = new LabManager({ db, cfg: env.cfg, storageDir: env.cfg.storageDir, project: slug => registry.require(slug), monitor: false });
  await manager.create('alpha', 'browser');
  await manager.start('alpha', 'browser');
  return manager;
}
const browser = (over: Record<string, unknown> = {}) => ({ kind: 'browser', mode: 'static', service: 'web', executable: chrome, timeout_seconds: 30, assertions: [{ kind: 'exists', selector: '#message' }, { kind: 'text_contains', selector: '#message', text: 'Hello static lab' }, { kind: 'title_contains', text: 'Static fixture' }], ...over });
it('requires explicit static mode and refuses model script/evaluate config', () => {
  expect(() => BrowserCheckSchema.parse({ ...browser(), mode: undefined })).toThrow();
  expect(() => BrowserCheckSchema.parse({ ...browser(), evaluate: 'fetch(1)' })).toThrow();
  expect(() => BrowserCheckSchema.parse({ ...browser(), path: '//localhost:1' })).toThrow();
});
it.skipIf(!existsSync(chrome))('renders an actual static Chrome page with bounded screenshot retrieval and exact heads', async () => {
  const manager = await setup({ static: browser() });
  const result = await manager.check('alpha', 'browser', 'static');
  expect(result, result.stderr + JSON.stringify(db!.prepare("SELECT data_json FROM lab_events WHERE type='browser_check_failed'").all())).toMatchObject({ exitCode: 0, killed: null, browser: { mode: 'static', scriptsExecuted: false } });
  expect(result.browser?.heads.app).toBe(result.revision);
  expect(result.browser?.assertions.every(item => item.passed)).toBe(true);
  const artifact = result.browser!.artifacts[0]!;
  const retrieved = manager.browserArtifact('alpha', 'browser', result.id, artifact.id);
  expect(retrieved.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(retrieved.bytes.length).toBe(artifact.bytes);
  expect(() => manager.browserArtifact('alpha', 'outside', result.id, artifact.id)).toThrow();
  expect(JSON.stringify(manager.publicStatus('alpha', 'browser'))).not.toContain('base64');
  const rows = z.array(z.object({ data_json: z.string() })).parse(db!.prepare("SELECT data_json FROM lab_events WHERE lab_id=? AND type='browser_check_started'").all(manager.status('alpha', 'browser').lab.id));
  for (const row of rows) {
    const event = z.object({ pid: z.number() }).parse(JSON.parse(row.data_json));
    expect(processAlive(event.pid)).toBe(false);
  }
  expect(existsSync(path.join(manager.status('alpha', 'browser').lab.root, 'checks', result.id, 'profile'))).toBe(false);
  expect(hits).toBe(0);
  expect(connections).toBe(0);
}, 60000);
it.skipIf(!existsSync(chrome))('fails static assertions and never reports hydration or script execution as success', async () => {
  const manager = await setup({ missing: browser({ assertions: [{ kind: 'exists', selector: '#missing' }] }), hydrated: browser({ path: '/hydrated', assertions: [{ kind: 'exists', selector: '#hydrated' }], screenshot: false }) });
  const missing = await manager.check('alpha', 'browser', 'missing');
  expect(missing.exitCode).toBe(1);
  expect(missing.browser!.assertions[0]!.passed).toBe(false);
  expect(missing.browser!.artifacts).toHaveLength(1);
  const hydrated = await manager.check('alpha', 'browser', 'hydrated');
  expect(hydrated.exitCode).toBe(1);
  expect(hydrated.browser!.scriptsExecuted).toBe(false);
  expect(hydrated.browser!.assertions[0]!.passed).toBe(false);
  expect(hits).toBe(0);
  expect(connections).toBe(0);
}, 90000);
it.skipIf(!existsSync(chrome))('denies cross-origin redirects and subresources before contacting a foreign loopback service', async () => {
  const manager = await setup({ redirect: browser({ path: '/redirect', screenshot: false }), foreign: browser({ path: '/foreign', assertions: [{ kind: 'exists', selector: '#message' }], screenshot: false }) });
  const redirect = await manager.check('alpha', 'browser', 'redirect');
  expect(redirect.exitCode).toBe(1);
  expect(redirect.browser!.violations.join(' ')).toMatch(/redirect/i);
  const foreign = await manager.check('alpha', 'browser', 'foreign');
  expect(foreign.exitCode).toBe(1);
  expect(foreign.browser!.violations.join(' ')).toMatch(/outside the declared service origin/);
  expect(hits).toBe(0);
  expect(connections).toBe(0);
}, 90000);
it.skipIf(!existsSync(chrome))('enforces response and screenshot budgets and verifies artifact integrity without exposing pixels in status', async () => {
  const manager = await setup({ large: browser({ path: '/large', max_resource_bytes: 1024, screenshot: false }), tiny: browser({ max_screenshot_bytes: 1024 }), count: browser({ max_resources: 1, screenshot: false }), valid: browser() });
  const large = await manager.check('alpha', 'browser', 'large');
  expect(large.exitCode).toBe(1);
  expect(large.browser!.violations.join(' ')).toMatch(/byte limit/);
  const count = await manager.check('alpha', 'browser', 'count');
  expect(count.exitCode).toBe(1);
  expect(count.browser!.requests).toBeLessThanOrEqual(101);
  expect(count.browser!.violations.join(' ')).toMatch(/resource count/);
  const tiny = await manager.check('alpha', 'browser', 'tiny');
  expect(tiny.exitCode).toBe(1);
  expect(tiny.browser!.artifacts).toHaveLength(0);
  const valid = await manager.check('alpha', 'browser', 'valid');
  expect(valid.exitCode).toBe(0);
  const artifact = valid.browser!.artifacts[0]!;
  const file = path.join(manager.status('alpha', 'browser').lab.root, 'checks', valid.id, artifact.id + '.png');
  writeFileSync(file, Buffer.alloc(artifact.bytes + 1));
  expect(() => manager.browserArtifact('alpha', 'browser', valid.id, artifact.id)).toThrow(/size/);
  expect(JSON.stringify(valid.browser)).not.toContain('C:');
  expect(JSON.stringify(valid.browser)).not.toContain('base64');
}, 120000);
it.skipIf(!existsSync(chrome))('refuses a foreign port rebound while the recorded service wrapper remains running and never launches Chrome or contacts the foreign listener', async () => {
  const manager = await setup({ static: browser() });
  const status = manager.status('alpha', 'browser');
  const port = status.lab.ports.web!;
  await fetch(status.urls.web!.replace(/\/$/, '') + '/release');
  const deadline = Date.now() + 3000;
  while (!await portAvailable(port) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 30));
  expect(manager.status('alpha', 'browser').services[0]!.state).toBe('running');
  let foreignHits = 0;
  const foreign = createServer((_req, res) => {
    foreignHits++;
    res.end('<h1 id="message">foreign</h1>');
  });
  await new Promise<void>(resolve => foreign.listen(port, '127.0.0.1', resolve));
  try {
    const result = await manager.check('alpha', 'browser', 'static');
    expect(result.exitCode).toBe(1);
    expect(result.browser!.artifacts).toHaveLength(0);
    expect(foreignHits).toBe(0);
    expect(db!.prepare("SELECT 1 FROM lab_events WHERE type='browser_check_started'").get()).toBeUndefined();
  }
  finally {
    await new Promise<void>(resolve => foreign.close(() => resolve()));
  }
}, 30000);
it.skipIf(!existsSync(chrome))('cancels an in-flight browser check and closes its owned Chrome/profile before manager shutdown returns', async () => {
  const manager = await setup({ slow: browser({ path: '/slow', screenshot: false }) });
  const pending = manager.check('alpha', 'browser', 'slow');
  const deadline = Date.now() + 20000;
  let event: {
    checkId: string;
    pid: number;
  } | undefined;
  while (Date.now() < deadline) {
    const row = z.object({ data_json: z.string() }).optional().parse(db!.prepare("SELECT data_json FROM lab_events WHERE type='browser_check_started' ORDER BY id DESC LIMIT 1").get());
    if (row) {
      event = z.object({ checkId: z.string(), pid: z.number() }).parse(JSON.parse(row.data_json));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(event).toBeDefined();
  await manager.close();
  const result = await pending;
  expect(result.exitCode).toBe(1);
  expect(result.killed).toBe('cancelled');
  expect(processAlive(event!.pid)).toBe(false);
  expect(existsSync(path.join(manager.status('alpha', 'browser').lab.root, 'checks', event!.checkId, 'profile'))).toBe(false);
}, 60000);
it.skipIf(!existsSync(chrome))('times out browser startup/check work and removes its owned profile/processes', async () => {
  const manager = await setup({ timeout: browser({ timeout_seconds: 1, path: '/slow', screenshot: false }) });
  const result = await manager.check('alpha', 'browser', 'timeout');
  expect(result.exitCode).toBe(1);
  expect(result.killed).toBe('timeout_or_guard_failure');
  const rows = z.array(z.object({ data_json: z.string() })).parse(db!.prepare("SELECT data_json FROM lab_events WHERE type='browser_check_spawned'").all());
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const event = z.object({ pid: z.number(), checkId: z.string() }).parse(JSON.parse(row.data_json));
    expect(processAlive(event.pid)).toBe(false);
    expect(existsSync(path.join(manager.status('alpha', 'browser').lab.root, 'checks', event.checkId, 'profile'))).toBe(false);
  }
}, 30000);
