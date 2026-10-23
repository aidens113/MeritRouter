import { z } from "zod";
import net from "node:net";
import type { LabManager } from "./lab.js";
import type { LabRecord } from "./store.js";
import { BrowserEvidenceSchema, type BrowserCheck, type BrowserEvidence } from "./browser-schema.js";
import { BrowserProtocol, type BrowserEvent } from "./browser-protocol.js";
import { BrowserResourceBroker, ownedBrowserEndpoint } from "./browser-network.js";
import { launchOwnedBrowser, type OwnedBrowser } from "./browser-process.js";
import { writeBrowserScreenshot } from "./browser-artifacts.js";
import { dirtyPaths, git } from "../workspaces/git.js";
const Attached = z.object({ sessionId: z.string(), targetInfo: z.object({ targetId: z.string(), type: z.string(), url: z.string() }) });
const Navigation = z.object({ frameId: z.string().optional(), errorText: z.string().optional(), loaderId: z.string().optional() });
const NodeResult = z.object({ nodeId: z.number().int() });
async function checkedHeads(lab: LabRecord): Promise<Record<string, string>> {
  const heads: Record<string, string> = {};
  for (const repo of lab.repositories) {
    if ((await dirtyPaths(repo.worktree)).length)
      throw new Error("browser checks require clean committed lab repositories");
    heads[repo.alias] = (await git(repo.worktree, ["rev-parse", "HEAD"])).trim();
  }
  return heads;
}
/** An explicit static browser renderer. Application scripts never execute. */
export async function runBrowserCheck(manager: LabManager, lab: LabRecord, checkId: string, spec: BrowserCheck, signal?: AbortSignal) {
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort("timeout"), spec.timeout_seconds * 1000);
  const active = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const heads = await checkedHeads(lab);
  const evidence: BrowserEvidence = { mode: "static", scriptsExecuted: false, assertions: [], console: [], pageErrors: [], violations: [], requests: 0, blockedConnections: 0, blockedTargets: 0, responseBytes: 0, heads, artifacts: [] };
  let browser: OwnedBrowser | undefined;
  let protocol: BrowserProtocol | undefined;
  let cleanupFailed = false;
  let killed: string | null = null;
  let phase = "ownership";
  let guarded = false;
  let rootSession: string | null = null;
  let expectedTarget: string | null = null;
  const configurations = new Map<string, Promise<string>>();
  const events = new Set<Promise<void>>();
  let broker: BrowserResourceBroker | undefined;
  const bounded = (text: string) => manager.redact(lab.project, lab.name, text).replace(/file:\/\/[^\s]+|[A-Za-z]:\\[^\s]+/g, "[host path]").slice(0, 2000);
  const violation = (text: string) => {
    if (evidence.violations.length < 20)
      evidence.violations.push(bounded(text));
  };
  const loaded = new Set<string>();
  const configure = async (session: string): Promise<string> => {
    const client = protocol!;
    await client.call("Page.enable", {}, session);
    await client.call("Page.setLifecycleEventsEnabled", { enabled: true }, session);
    await client.call("Runtime.enable", {}, session);
    await client.call("Log.enable", {}, session);
    await client.call("Network.enable", { maxTotalBufferSize: 1048576, maxResourceBufferSize: 262144 }, session);
    await client.call("Network.setCacheDisabled", { cacheDisabled: true }, session);
    await client.call("Network.setBypassServiceWorker", { bypass: true }, session);
    await client.call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, session);
    await client.call("Emulation.setScriptExecutionDisabled", { value: true }, session);
    await client.call("Emulation.setDeviceMetricsOverride", { ...spec.viewport, deviceScaleFactor: 1, mobile: false }, session);
    await client.call("Runtime.runIfWaitingForDebugger", {}, session);
    // Test that an ordinary, unintercepted navigation cannot reach a local listening endpoint.
    const sockets = new Set<net.Socket>();
    let contacted = false;
    const probe = net.createServer(socket => {
      contacted = true;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = probe.address();
      if (!address || typeof address === "string")
        throw new Error("browser offline probe unavailable");
      const navigation = Navigation.parse(await client.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/meritrouter-offline-probe` }, session));
      if (contacted || navigation.errorText !== "net::ERR_INTERNET_DISCONNECTED")
        throw new Error("browser offline enforcement could not be verified");
    }
    finally {
      for (const socket of sockets)
        socket.destroy();
      await new Promise<void>(resolve => probe.close(() => resolve()));
    }
    await client.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, session);
    await client.call("Runtime.runIfWaitingForDebugger", {}, session);
    return session;
  };
  const event = (value: BrowserEvent): void => {
    if (value.method === "Target.attachedToTarget") {
      const attached = Attached.parse(value.params);
      if (attached.targetInfo.type !== "page" || attached.targetInfo.url !== "about:blank" || configurations.size) {
        evidence.blockedTargets = Math.min(1000, evidence.blockedTargets + 1);
        const internal = ["browser_ui", "background_page", "service_worker"].includes(attached.targetInfo.type) && /^(chrome|chrome-extension):/.test(attached.targetInfo.url);
        if (!internal)
          violation("Unexpected application target was refused before execution");
        const work = protocol!.call("Target.closeTarget", { targetId: attached.targetInfo.targetId }).then(() => undefined).catch(() => undefined);
        events.add(work);
        void work.finally(() => events.delete(work));
        return;
      }
      const work = configure(attached.sessionId);
      configurations.set(attached.targetInfo.targetId, work);
      void work.catch(() => abort.abort("browser guard configuration failed"));
      return;
    }
    if (!value.sessionId)
      return;
    if (value.method === "Fetch.requestPaused")
      broker!.paused(value.params, value.sessionId);
    if (value.method === "Page.lifecycleEvent") {
      const lifecycle = z.object({ loaderId: z.string(), name: z.string() }).parse(value.params);
      if (lifecycle.name === "load")
        loaded.add(lifecycle.loaderId);
    }
    if (value.method === "Runtime.exceptionThrown" && evidence.pageErrors.length < 20)
      evidence.pageErrors.push("Browser reported a page exception in static mode");
    if (value.method === "Log.entryAdded" && evidence.console.length < 20) {
      const entry = z.object({ entry: z.object({ text: z.string(), level: z.string() }) }).parse(value.params).entry;
      evidence.console.push(bounded(`${entry.level}: ${entry.text}`));
    }
    if (value.method === "Runtime.consoleAPICalled" && evidence.console.length < 20)
      evidence.console.push("Browser console event observed while application scripts are disabled");
    if (value.method === "Network.webSocketCreated" || value.method === "Network.webTransportCreated") {
      violation("Browser network side channel was refused");
      abort.abort("network side channel");
    }
    if (value.method === "Page.frameRequestedNavigation") {
      const request = z.object({ url: z.string() }).parse(value.params);
      if (request.url !== "about:blank" && new URL(request.url).origin !== broker!.endpoint.origin)
        violation("Cross-origin frame navigation was refused");
    }
  };
  try {
    const endpoint = await ownedBrowserEndpoint(manager, lab, spec.service);
    phase = "launch";
    browser = await launchOwnedBrowser(lab, checkId, spec.executable, active, () => {
      evidence.blockedConnections = Math.min(1000, evidence.blockedConnections + 1);
    }, pid => manager.store.event(lab.id, "browser_check_spawned", { checkId, pid }));
    manager.store.event(lab.id, "browser_check_started", { checkId, pid: browser.pid, mode: "static" });
    phase = "connect";
    protocol = await BrowserProtocol.connect(browser.url, active);
    broker = new BrowserResourceBroker(manager, lab, spec, endpoint, protocol, evidence, active, reason => abort.abort(reason));
    protocol.onEvent(event);
    await protocol.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const targets = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })) }).parse(await protocol.call("Target.getTargets"));
    const pages = targets.targetInfos.filter(item => item.type === "page" && item.url === "about:blank");
    const target = pages[0] ?? z.object({ targetId: z.string() }).parse(await protocol.call("Target.createTarget", { url: "about:blank" }));
    expectedTarget = target.targetId;
    while (!configurations.has(expectedTarget)) {
      if (active.aborted)
        throw new Error("browser check stopped");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    phase = "configure";
    rootSession = await configurations.get(expectedTarget)!;
    guarded = true;
    phase = "navigate";
    const navigation = Navigation.parse(await protocol.call("Page.navigate", { url: new URL(spec.path, endpoint.origin).href }, rootSession));
    if (navigation.errorText)
      throw new Error("browser navigation failed within its network boundary");
    while (!navigation.loaderId || !loaded.has(navigation.loaderId)) {
      if (active.aborted)
        throw new Error("browser check stopped");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    await broker.idle();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, spec.settle_ms);
      active.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("browser check stopped"));
      }, { once: true });
    });
    await broker.idle();
    phase = "assertions";
    const document = z.object({ root: z.object({ nodeId: z.number().int() }) }).parse(await protocol.call("DOM.getDocument", { depth: 0 }, rootSession));
    for (const assertion of spec.assertions) {
      const selector = assertion.kind === "title_contains" ? "title" : assertion.selector;
      const node = NodeResult.parse(await protocol.call("DOM.querySelector", { nodeId: document.root.nodeId, selector }, rootSession));
      let passed = node.nodeId > 0;
      if (passed && assertion.kind !== "exists") {
        const described = z.object({ node: z.unknown() }).parse(await protocol.call("DOM.describeNode", { nodeId: node.nodeId, depth: -1 }, rootSession));
        const pending: unknown[] = [described.node];
        let text = "";
        let count = 0;
        while (pending.length && text.length < 8192) {
          if (++count > 20000)
            throw new Error("browser DOM assertion exceeded its node limit");
          const current = z.object({ nodeType: z.number().int(), nodeValue: z.string(), children: z.array(z.unknown()).max(20000).optional() }).parse(pending.pop());
          if (current.nodeType === 3 || current.nodeType === 4)
            text += current.nodeValue.slice(0, 8192 - text.length);
          if (current.children)
            pending.push(...[...current.children].reverse());
        }
        passed = text.includes(assertion.text);
      }
      evidence.assertions.push({ kind: assertion.kind, passed, detail: passed ? "Declared static DOM assertion passed" : "Declared static DOM assertion failed; scripts and hydration are disabled" });
    }
    phase = "screenshot";
    if (spec.screenshot) {
      const screenshot = z.object({ data: z.string().max(5592416) }).parse(await protocol.call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, rootSession));
      if (screenshot.data.length > Math.ceil(spec.max_screenshot_bytes / 3) * 4 + 4)
        throw new Error("browser screenshot exceeded its byte limit");
      evidence.artifacts.push(writeBrowserScreenshot(lab, checkId, Buffer.from(screenshot.data, "base64"), spec.max_screenshot_bytes));
    }
    await ownedBrowserEndpoint(manager, lab, spec.service, endpoint);
    if (JSON.stringify(await checkedHeads(lab)) !== JSON.stringify(heads)) {
      killed = "revision_changed";
      violation("Lab revision changed during browser check");
    }
  }
  catch (error) {
    manager.store.event(lab.id, "browser_check_failed", { checkId, phase, error: bounded(error instanceof Error ? error.message : "invalid browser response") });
    killed = active.aborted ? (signal?.aborted ? "cancelled" : "timeout_or_guard_failure") : "browser_check_failed";
    violation("Static browser check failed or its configured containment could not be verified");
  }
  finally {
    clearTimeout(deadline);
    protocol?.close();
    await Promise.allSettled([...events]);
    if (browser) {
      try {
        await browser.close();
        manager.store.event(lab.id, "browser_check_closed", { checkId, pid: browser.pid });
      }
      catch {
        cleanupFailed = true;
        killed = "cleanup_refused";
        violation("Browser cleanup was refused; private ownership evidence was retained");
      }
    }
  }
  const validated = BrowserEvidenceSchema.parse(evidence);
  const passed = !killed && !cleanupFailed && !validated.violations.length && !validated.pageErrors.length && validated.assertions.length === spec.assertions.length && validated.assertions.every(assertion => assertion.passed);
  return { exitCode: passed ? 0 : 1, killed, stdout: `Static browser check: ${passed ? "passed" : "failed"}; application scripts disabled. ${validated.assertions.filter(item => item.passed).length}/${spec.assertions.length} assertions passed.`, stderr: validated.violations.join("\n"), durationMs: Date.now() - started, browser: validated };
}
