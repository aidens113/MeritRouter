import { expect, it } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BudgetRequests } from '../src/admission/budget-requests.js';
import { extraRequests } from '../src/admission/job-pool.js';
import { makeEnv, open, reply, ScriptedClient, summarizeTask } from './helpers.js';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const exec = promisify(execFile);
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

it.each(['stdio', 'http'] as const)('real CLI and MCP %s decisions preserve grants, refusals, and accounting', async transport => {
  const env = makeEnv();
  const sy = open(env, new ScriptedClient(() => reply('must never run')), { worker: false });
  const requests = new BudgetRequests(sy.db);
  const client = new Client({ name: 'process-budget-test', version: '1' });
  let child: ChildProcess | undefined;
  let url = '';
  try {
    const tasks = await sy.submitTasks(Array.from({ length: 5 }, (_, i) => summarizeTask({ label: `budget-${i}` })));
    const filed = tasks.map((t, i) => requests.file({ taskId: t.taskId, jobId: null, role: 'reader', requests: 2, reason: 'fixture needs two more', used: 0, cap: 1, approver: i < 2 || i === 4 ? 'human' : 'external' }));
    const cli = (...args: string[]) => exec(process.execPath, [path.join(dist, 'cli.js'), 'budget', ...args, '--config', env.cfg.configPath, '--json'], { env: { PATH: process.env.PATH ?? '' }, windowsHide: true });
    const approved = JSON.parse((await cli('approve', String(filed[0]!.id), '--grant', '2', '--reason', 'fixture approval')).stdout);
    expect(approved).toMatchObject({ status: 'approved', granted: 2 });
    const denied = JSON.parse((await cli('deny', String(filed[1]!.id), '--reason', 'fixture denial')).stdout);
    expect(denied).toMatchObject({ status: 'denied', granted: 0 });
    await expect(cli('approve', String(filed[0]!.id), '--grant', '2')).rejects.toThrow();
    await expect(cli('approve', String(filed[2]!.id), '--grant', '0')).rejects.toThrow();
    const args = [path.join(dist, 'mcp.js'), '--config', env.cfg.configPath, '--no-worker'];
    if (transport === 'stdio') {
      await client.connect(new StdioClientTransport({ command: process.execPath, args, env: { PATH: process.env.PATH ?? '' } }));
    } else {
      child = spawn(process.execPath, [...args, '--http', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' }, windowsHide: true });
      const proc = child;
      url = await new Promise<string>((resolve, reject) => {
        let log = '';
        const timer = setTimeout(() => reject(new Error(`MCP URL not printed: ${log}`)), 15000);
        proc.stderr!.on('data', b => { log += b; const m = /at (http:\/\/\S+\/mcp)/.exec(log); if (m) { clearTimeout(timer); resolve(m[1]!); } });
        proc.once('exit', code => { clearTimeout(timer); reject(new Error(`MCP exited ${code}: ${log}`)); });
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    }
    const malformed = await client.callTool({ name: 'decide_budget_request', arguments: { id: filed[2]!.id, approve: true, grant: 0, reason: 'invalid' } });
    expect(malformed.isError).toBe(true);
    expect(requests.get(filed[2]!.id)!.status).toBe('pending');
    const humanOnly = await client.callTool({ name: 'decide_budget_request', arguments: { id: filed[4]!.id, approve: true, grant: 2, reason: 'MCP cannot decide this' } });
    expect(humanOnly.isError).toBe(true);
    expect(requests.get(filed[4]!.id)!.status).toBe('pending');
    const mcpApproval = await client.callTool({ name: 'decide_budget_request', arguments: { id: filed[2]!.id, approve: true, grant: 2, reason: 'MCP approved' } });
    expect(JSON.parse(text(mcpApproval))).toMatchObject({ status: 'approved', granted: 2, decidedBy: 'external:mcp:process-budget-test' });
    const mcpDenial = await client.callTool({ name: 'decide_budget_request', arguments: { id: filed[3]!.id, approve: false, reason: 'MCP denied' } });
    expect(JSON.parse(text(mcpDenial))).toMatchObject({ status: 'denied', granted: 0 });
    expect(tasks.map(t => extraRequests(sy.db, t.taskId))).toEqual([2, 0, 2, 0, 0]);
    expect(sy.db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()).toEqual({ n: 0 });
    expect(sy.db.prepare('SELECT COUNT(*) AS n FROM request_charges').get()).toEqual({ n: 0 });
  } finally {
    await client.close().catch(() => undefined);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r())); child.kill('SIGKILL'); await exited;
    }
    await sy.close();
    if (url) await expect(fetch(url)).rejects.toThrow();
    env.cleanup();
  }
}, 40000);
