import { RequestPersistenceError } from "../src/admission/request-ledger.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SessionRecorder } from "../src/sessions/recorder.js";
import { Classifier } from "../src/scoring/classifier.js";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { TaskFeatures } from "../src/scoring/score.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const features: TaskFeatures = { mode: "completion", linesInScope: 10, linesApproximate: false, contextTokens: 30, repositories: 1, acceptanceCriteria: 1, checksRequired: false, outputSchema: false, retryAfterFailure: false, inputModalities: ["text"], scopeSample: ["core:src/app.ts"] };
const tags = { kind: "locate", reasoning: "lookup", novelty: "existing_pattern", risk: [], environment: [], ambiguity: "low" };
function setup(onRequest?: () => void) {
  const client = new ScriptedClient((req, n) => {
    onRequest?.();
    const text = String(req.messages[1]!.content);
    const ids = [...text.matchAll(/<item id="(c\d+)">/g)].map(match => match[1]);
    return reply(JSON.stringify({ items: ids.map(id => ({ id, tags, confidence: .9, rationale: `verdict-${n}`, suggestedTier: "T1" })) }), { model: req.model, provider: req.provider });
  });
  env = makeEnv({ endpoints: [endpoint({ totalParametersB: 120 })], config: baseConfig({ repositories: {}, projects: { alpha: { repositories: { core: { path: "repo" } } }, beta: { repositories: { core: { path: "repo" } } } }, scoring: { batch_window_ms: 25, max_batch: 8, cache: true } }) });
  sy = open(env, client, { worker: false });
  const classifier = new Classifier(sy.cfg, sy.db, sy.gate, "scope-fixture", () => sy!.router.plan("summarize", "T1", ["text"]));
  return { client, classifier };
}
function item(id: string, project: string, goal = id) {
  sy!.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id, goal, repositoryAliases: ["core"] }))], { project });
  sy!.tasks.claim("scope-owner", { maxConcurrent: 20, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const task = sy!.tasks.get(id)!;
  return { taskId: id, lease: capturedLease(task), leaseOwner: "scope-owner", budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, spec: task.spec, specHash: task.row.spec_hash, features };
}

it("partitions simultaneous projects into distinct prompts, journals and physical charges", async () => {
  const { classifier, client } = setup();
  const a = item("alpha-one", "alpha", "alpha-private-goal"), b = item("beta-one", "beta", "beta-private-goal"), a2 = item("alpha-two", "alpha", "alpha-second-goal");
  const results = await Promise.all([classifier.classify(a), classifier.classify(b), classifier.classify(a2)]);
  expect(results.every(Boolean)).toBe(true); expect(client.requests).toHaveLength(2);
  const alpha = client.requests.find(req => String(req.messages[1]!.content).includes("alpha-private-goal"))!;
  const beta = client.requests.find(req => String(req.messages[1]!.content).includes("beta-private-goal"))!;
  expect(String(alpha.messages[1]!.content)).not.toContain("beta-private-goal");
  expect(String(alpha.messages[1]!.content)).toContain("alpha-second-goal");
  expect(alpha.max_tokens).toBe(1600); expect(beta.max_tokens).toBe(1000);
  expect(String(beta.messages[1]!.content)).not.toContain("alpha-private-goal");
  const rows = sy!.db.prepare("SELECT r.id,r.project_id,COUNT(c.task_id) AS n FROM model_requests r JOIN request_charges c ON c.request_id=r.id GROUP BY r.id ORDER BY r.project_id").all();
  expect(rows).toEqual([expect.objectContaining({ project_id: "alpha", n: 2 }), expect.objectContaining({ project_id: "beta", n: 1 })]);
  for (const [id, foreign] of [["alpha-one", "beta-private-goal"], ["alpha-two", "beta-private-goal"], ["beta-one", "alpha-private-goal"]]) {
    const sessions = sy!.sessions.forTask(id!); expect(sessions).toHaveLength(1);
    expect(readFileSync(sessions[0]!.logPath, "utf8")).not.toContain(foreign!);
  }
});

it("namespaces cache by persisted project while retaining same-project and rulebook behavior", async () => {
  const { classifier, client } = setup();
  const a = item("a", "alpha", "same spec"), b = item("b", "beta", "same spec"), a2 = item("a2", "alpha", "same spec");
  expect(a.specHash).toBe(b.specHash);
  expect((await classifier.classify(a))!.rationale).toBe("verdict-1");
  expect((await classifier.classify(b))!.rationale).toBe("verdict-2");
  expect((await classifier.classify(a2))!.rationale).toBe("verdict-1");
  expect(client.requests).toHaveLength(2);
  const changed = new Classifier(sy!.cfg, sy!.db, sy!.gate, "another-rulebook", () => sy!.router.plan("summarize", "T1", ["text"]));
  expect((await changed.classify(a2))!.rationale).toBe("verdict-3");
});

it("does not trust legacy unscoped cache or resolve missing/unassigned/deleted project rows", async () => {
  const { classifier, client } = setup();
  const a = item("a", "alpha");
  sy!.db.prepare("INSERT INTO classifications(spec_hash,rulebook_version,data_json,created_at) VALUES (?,?,?,?)").run(a.specHash, "scope-fixture", JSON.stringify({ tags, confidence: .9, rationale: "legacy-private", suggestedTier: "T1" }), Date.now());
  expect((await classifier.classify(a))!.rationale).toBe("verdict-1");
  const invalid = item("invalid", "beta");
  sy!.db.prepare("UPDATE tasks SET project_id = '' WHERE id = ?").run(invalid.taskId);
  expect(await classifier.classify(invalid)).toBeNull();
  sy!.db.prepare("UPDATE tasks SET project_id = 'deleted-project' WHERE id = ?").run(invalid.taskId);
  expect(await classifier.classify(invalid)).toBeNull();
  expect(await classifier.classify({ ...a, taskId: "absent" })).toBeNull();
  expect(client.requests).toHaveLength(1);
});

it("rechecks captured project before dispatch", async () => {
  const { classifier, client } = setup(); const a = item("a", "alpha");
  const pending = classifier.classify(a);
  sy!.db.prepare("UPDATE tasks SET project_id='beta' WHERE id='a'").run();
  expect(await pending).toBeNull(); expect(client.requests).toHaveLength(0);
});


it("discards a late verdict instead of caching under a changed project", async () => {
  const { classifier, client } = setup(() => { sy!.db.prepare("UPDATE tasks SET project_id='beta' WHERE id='a'").run(); });
  const a = item("a", "alpha");
  expect(await classifier.classify(a)).toBeNull(); expect(client.requests).toHaveLength(1);
  expect(sy!.db.prepare("SELECT * FROM classifications").all()).toEqual([]);
});

it("refuses cached verdicts for archived/deleted projects and malformed project identity", async () => {
  const { classifier, client } = setup(); const a = item("a", "alpha");
  expect(await classifier.classify(a)).not.toBeNull();
  sy!.db.prepare("UPDATE projects SET archived_at=? WHERE id='alpha'").run(Date.now());
  expect(await classifier.classify(a)).toBeNull();
  sy!.db.prepare("DELETE FROM projects WHERE id='alpha'").run();
  expect(await classifier.classify(a)).toBeNull();
  sy!.db.prepare("UPDATE tasks SET project_id='not a valid project' WHERE id='a'").run();
  expect(await classifier.classify(a)).toBeNull();
  expect(client.requests).toHaveLength(1);
});

it("keeps the reserved qualification scope isolated without requiring a public project row", async () => {
  const { classifier, client } = setup();
  const q = item("q", "_qualification", "same spec"), a = item("a", "alpha", "same spec");
  expect(sy!.db.prepare("SELECT * FROM projects WHERE id='_qualification'").get()).toBeUndefined();
  expect((await classifier.classify(q))!.rationale).toBe("verdict-1");
  expect((await classifier.classify(a))!.rationale).toBe("verdict-2");
  expect(client.requests).toHaveLength(2);
});

it("retains admission cancellation semantics with no partially charged same-project batch", async () => {
  const { classifier, client } = setup(); const a = item("a", "alpha"), b = item("b", "alpha");
  const pending = [classifier.classify(a), classifier.classify(b)];
  sy!.tasks.requestCancel([b.taskId]);
  expect(await Promise.all(pending)).toEqual([null, null]);
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare("SELECT * FROM model_requests").all()).toEqual([]);
  expect(sy!.db.prepare("SELECT * FROM request_charges").all()).toEqual([]);
});

it("does not publish or cache a late verdict for a replaced same-owner generation", async () => {
  const { classifier, client } = setup(() => { sy!.db.prepare("UPDATE tasks SET run_count=run_count+1 WHERE id='generation'").run(); });
  const a = item("generation", "alpha");
  expect(await classifier.classify(a)).toBeNull();
  expect(client.requests).toHaveLength(1);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM classifications').pluck().get()).toBe(0);
});

it.each(['reserve', 'reconcile'])('propagates classifier %s persistence uncertainty instead of converting to a fallback verdict', async stage => {
  const { classifier, client } = setup(), a = item('persist-classifier', 'alpha');
  if (stage === 'reserve') {
    const reserve = sy!.gate.ledger.reserve.bind(sy!.gate.ledger);
    vi.spyOn(sy!.gate.ledger, 'reserve').mockImplementation(async input => { await reserve(input); throw new Error('lost reserve ACK'); });
  } else {
    const reconcile = sy!.gate.ledger.reconcile.bind(sy!.gate.ledger);
    vi.spyOn(sy!.gate.ledger, 'reconcile').mockImplementation(async (...args) => { await reconcile(...args); throw new Error('lost reconcile ACK'); });
  }
  await expect(classifier.classify(a)).rejects.toBeInstanceOf(RequestPersistenceError);
  expect(client.requests).toHaveLength(stage === 'reserve' ? 0 : 1);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM model_requests').pluck().get()).toBe(1);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM classifications').pluck().get()).toBe(0);
});


it.each([
  ['reserve', 'finalizer'], ['reconcile', 'finalizer'],
  ['reserve', 'recorder'], ['reconcile', 'recorder'],
] as const)('preserves %s uncertainty when session %s fails during finalization', async (stage, failure) => {
  const { classifier, client } = setup(), a = item('persist-finalizer', 'alpha');
  let original: unknown;
  const request = sy!.gate.request.bind(sy!.gate);
  vi.spyOn(sy!.gate, 'request').mockImplementation(async input => {
    try { return await request(input); }
    catch (error) { original = error; throw error; }
  });
  if (stage === 'reserve') {
    const reserve = sy!.gate.ledger.reserve.bind(sy!.gate.ledger);
    vi.spyOn(sy!.gate.ledger, 'reserve').mockImplementation(async input => { await reserve(input); throw new Error('lost reserve ACK'); });
  } else {
    const reconcile = sy!.gate.ledger.reconcile.bind(sy!.gate.ledger);
    vi.spyOn(sy!.gate.ledger, 'reconcile').mockImplementation(async (...args) => { await reconcile(...args); throw new Error('lost settle ACK'); });
  }
  if (failure === 'finalizer') {
    vi.spyOn(classifier as unknown as { endSession: () => void }, 'endSession').mockImplementation(() => { throw new Error('finalization failed'); });
  } else {
    vi.spyOn(SessionRecorder.prototype, 'end').mockImplementation(() => { throw new Error('recorder end failed'); });
  }
  const observed = await classifier.classify(a).catch(error => error);
  expect(observed).toBe(original);
  expect(original).toBeInstanceOf(RequestPersistenceError);
  // The precise Gate error, including request identity/stage, survives publication.
  expect(client.requests).toHaveLength(stage === 'reserve' ? 0 : 1);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM classifications').pluck().get()).toBe(0);
});
