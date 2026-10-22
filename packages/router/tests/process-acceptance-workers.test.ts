import { rm } from "node:fs/promises";
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask } from './helpers.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

it('independent CLI workers claim each task once and share the provider concurrency ceiling', async () => {
  let active = 0, peak = 0, calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      JSON.parse(body);
      calls++; active++; peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          model: 'vendor/big-a:free', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(goodOutput()) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }));
      }, 250);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const config = baseConfig({
    providers: { local: { base_url: `http://127.0.0.1:${port}/v1`, keys: [{ api_key: 'fixture-only', billing_class: 'free_tier' }] } },
    execution: { max_concurrent_tasks: 4, lease_seconds: 10 },
    team: { provider_concurrency_start: 1, provider_concurrency_max: 1, provider_concurrency_limits: { local: 1 } },
    profiles: { summarize: { mode: 'completion', min_total_parameters_b: 30, max_model_requests: 2, classify: 'never', batching: { enabled: false } } },
  });
  const env = makeEnv({ config, endpoints: [endpoint({ providerId: 'local' })] });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  const children: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  let logs = '';
  try {
    const submitted = await sy.submitTasks(Array.from({ length: 6 }, (_, i) => summarizeTask({ label: `process-${i}`, idempotencyKey: `process-${i}` })));
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, [cli, 'worker', '--config', env.cfg.configPath], { cwd: env.dir, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout!.on('data', b => { logs += b; }); child.stderr!.on('data', b => { logs += b; });
      closed.push(new Promise<void>(resolve => child.once('close', () => resolve())));
      child.on('error', error => { logs += `worker spawn error: ${error.message}`; });
      children.push(child);
    }
    const deadline = Date.now() + 30000;
    while (!sy.getStatus(submitted.map(t => t.taskId)).every(t => t.state === 'completed')) {
      if (Date.now() > deadline || children.some(c => c.exitCode !== null)) throw new Error(`workers failed to finish: ${logs}`);
      await pause(50);
    }
    expect(calls).toBe(6);
    expect(peak).toBe(1);
    const rows = sy.db.prepare("SELECT task_id, COUNT(*) AS n FROM events WHERE type = 'claimed' GROUP BY task_id").all() as Array<{ task_id: string; n: number }>;
    expect(rows).toHaveLength(6);
    expect(rows.every(r => r.n === 1)).toBe(true);
    expect(children.every(c => c.exitCode === null && c.signalCode === null)).toBe(true);
  } finally {
    // close follows process exit AND closure of its inherited stdio handles.
    // Register at spawn so an early child exit cannot be missed during teardown.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    let closeTimer: NodeJS.Timeout | undefined;
    let closeError: unknown;
    try {
      await Promise.race([
        Promise.all(closed),
        new Promise<never>((_, reject) => { closeTimer = setTimeout(() => reject(new Error(`owned worker stdio did not close: ${logs}`)), 5000); }),
      ]);
    } catch (error) { closeError = error; }
    finally { if (closeTimer) clearTimeout(closeTimer); }
    await sy.close();
    await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
    // Still close our database/server on a failed child drain, but retain its
    // fixture paths rather than removing data while ownership is uncertain.
    if (closeError) throw closeError;
    // Windows can retain short-lived Git directory handles after a killed CLI.
    // Retry only removal of this exact makeEnv-owned root; exhaustion still fails.
    await rm(env.dir, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 10 : 0, retryDelay: 50 });
  }
}, 40000);
