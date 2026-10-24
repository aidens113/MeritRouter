import { z } from "zod";
import type { LabManager } from "./lab.js";
import type { LabRecord } from "./store.js";
import { BrowserJourneyCheckSchema, BrowserJourneyEvidenceSchema, type BrowserJourneyCheck, type BrowserJourneyEvidence } from "./browser-journey-schema.js";
import { BrowserPipeProtocol } from "./browser-pipe.js";
import { launchDockerBrowser, DockerBrowserError, type OwnedDockerBrowser } from "./browser-docker.js";
import { JourneyResourceBroker } from "./browser-journey-network.js";
import { executeJourneyStep } from "./browser-journey-dom.js";
import { ownedBrowserEndpoint } from "./browser-network.js";
import { writeBrowserScreenshot } from "./browser-artifacts.js";
import { journeyInputsDigest, journeySourceSnapshot, journeyEnvironmentDigest } from "./browser-journey-evidence.js";
import { productDigest } from "../verification/product-spec.js";
import { assertLabEffect } from "./control-authority.js";
const Attached = z.object({ sessionId: z.string(), targetInfo: z.object({ targetId: z.string(), type: z.string(), url: z.string() }) });
/** Executes declared journeys only after actual OS/container containment; never falls back to a host browser. */
export async function runBrowserJourney(manager: LabManager, lab: LabRecord, checkId: string, check: BrowserJourneyCheck, signal?: AbortSignal) {
  const spec = BrowserJourneyCheckSchema.parse(check), started = Date.now(), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("journey_deadline"), spec.timeout_seconds * 1000);
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let browser: OwnedDockerBrowser | undefined, client: BrowserPipeProtocol | undefined, broker: JourneyResourceBroker | undefined;
  const setup = new Map<string, Promise<string>>(), events = new Set<Promise<unknown>>();
  let killed: string | null = null;
  const evidence: BrowserJourneyEvidence = { schemaVersion: 1, mode: "interactive", scriptsEnabled: false, status: "failed", cleanup: "complete", isolation: null, browser: null, heads: {}, trees: {}, specDigest: spec.specDigest, testDigest: productDigest(spec.steps), recipeDigest: productDigest(lab.recipe), environmentDigest: productDigest({ status: "not_established" }), dependencyDigest: productDigest({ status: "not_established" }), fixtureDigest: spec.fixtureDigest ?? productDigest({ status: "not_measured" }), fixtureAfterDigest: null, resourceDigest: productDigest([]), serviceIdentities: [], steps: [], console: [], pageErrors: [], violations: [], requests: 0, responseBytes: 0, artifacts: [], unknowns: [] };
  const bounded = (value: string) => {
    let text = manager.redact(lab.project, lab.name, value).replace(/file:\/\/[^\s]+|[A-Za-z]:\\[^\s]+/g, "[host path]"); for (const step of spec.steps)
      if (step.action === "fill" && step.text.length >= 3)
        text = text.replaceAll(step.text, "[journey input]"); return text.slice(0, 2000);
  };
  const violation = (value: string) => {
    if (evidence.violations.length < 20)
      evidence.violations.push(bounded(value)); controller.abort("journey_guard_failure");
  };
  try {
    assertLabEffect();
    const sources = await journeySourceSnapshot(lab, active);
    Object.assign(evidence, sources);
    const fixture = await journeyInputsDigest(lab, spec, active);
    evidence.fixtureDigest = fixture;
    if (spec.fixtureDigest !== null && fixture !== spec.fixtureDigest)
      throw new Error("journey_fixture_digest_mismatch");
    let endpoint = await ownedBrowserEndpoint(manager, lab, spec.service);
    evidence.serviceIdentities.push(productDigest(endpoint));
    browser = await launchDockerBrowser(lab, checkId, spec.isolation, active, Math.min(90000, spec.timeout_seconds * 1000 + 15000));
    evidence.isolation = { backend: browser.backend, generation: browser.generation, engineId: browser.engineId, imageId: browser.imageId };
    client = new BrowserPipeProtocol(browser.output, browser.input, active, { timeoutMs: spec.timeout_seconds * 1000 });
    const version = z.object({ product: z.string().max(200), protocolVersion: z.string().max(100) }).parse(await client.call("Browser.getVersion"));
    evidence.browser = version;
    await browser.assertOwned(active);
    const uploads: Record<string, string> = {};
    for (const [id, file] of Object.entries(spec.uploads))
      uploads[id] = await browser.installFixture(file.name, Buffer.from(file.base64, "base64"), active);
    evidence.environmentDigest = journeyEnvironmentDigest(evidence);
    broker = new JourneyResourceBroker(manager, lab, spec, endpoint, client, evidence, active, reason => controller.abort(reason));
    const configure = async (session: string) => {
      await client!.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session);
      await client!.call("Page.enable", {}, session);
      await client!.call("Runtime.enable", {}, session);
      await client!.call("Log.enable", {}, session);
      await client!.call("Network.enable", { maxTotalBufferSize: 1048576, maxResourceBufferSize: 262144 }, session);
      await client!.call("Network.setCacheDisabled", { cacheDisabled: true }, session);
      await client!.call("Network.setBypassServiceWorker", { bypass: true }, session);
      await client!.call("Emulation.setDeviceMetricsOverride", { width: spec.viewport.width, height: spec.viewport.height, mobile: spec.viewport.mobile, deviceScaleFactor: 1 }, session);
      await client!.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, session);
      await client!.call("Emulation.setScriptExecutionDisabled", { value: false }, session);
      await client!.call("Runtime.runIfWaitingForDebugger", {}, session);
      return session;
    };
    client.onEvent(event => {
      if (event.method === "Target.attachedToTarget") {
        const attached = Attached.parse(event.params);
        if (attached.targetInfo.type !== "page" || attached.targetInfo.url !== "about:blank" || setup.size) {
          violation("Unexpected browser target denied before application execution");
          const closing = client!.call("Target.closeTarget", { targetId: attached.targetInfo.targetId }).catch(() => { });
          events.add(closing);
          void closing.finally(() => events.delete(closing));
          return;
        }
        const pending = configure(attached.sessionId);
        setup.set(attached.targetInfo.targetId, pending);
        void pending.catch(() => controller.abort("journey_guard_setup_failed"));
        return;
      }
      if (!event.sessionId)
        return;
      if (event.method === "Fetch.requestPaused")
        broker!.paused(event.params, event.sessionId);
      if (event.method === "Runtime.exceptionThrown" && evidence.pageErrors.length < 20) {
        const exception = z.object({ exceptionDetails: z.object({ text: z.string().max(20000) }) }).parse(event.params);
        evidence.pageErrors.push(bounded(exception.exceptionDetails.text));
      }
      if (event.method === "Runtime.consoleAPICalled" && evidence.console.length < 20) {
        const message = z.object({ type: z.string(), args: z.array(z.object({ value: z.unknown().optional(), description: z.string().optional() })).max(100) }).parse(event.params);
        evidence.console.push(bounded(`${message.type}: ${message.args.map(arg => typeof arg.value === "string" ? arg.value : typeof arg.value === "number" || typeof arg.value === "boolean" ? String(arg.value) : "[object]").join(" ")}`));
      }
      if (["Network.webSocketCreated", "Network.webTransportCreated"].includes(event.method))
        violation("Unsupported browser network side channel attempted");
      if (event.method === "Page.frameRequestedNavigation") {
        const navigation = z.object({ url: z.string() }).parse(event.params);
        if (new URL(navigation.url, endpoint.origin).origin !== endpoint.origin)
          violation("Cross-origin navigation denied");
      }
    });
    await client.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const targets = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })) }).parse(await client.call("Target.getTargets"));
    const target = targets.targetInfos.find(item => item.type === "page" && item.url === "about:blank") ?? z.object({ targetId: z.string() }).parse(await client.call("Target.createTarget", { url: "about:blank" }));
    while (!setup.has(target.targetId)) {
      active.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const session = await setup.get(target.targetId)!;
    evidence.scriptsEnabled = true;
    await executeJourneyStep(client, session, { id: "initial-navigation", criterionIds: ["runtime-startup"], action: "navigate", path: spec.path }, endpoint.origin, active);
    for (const step of spec.steps) {
      active.throwIfAborted();
      assertLabEffect();
      const stepStarted = Date.now();
      try {
        if (step.action === "restart_service") {
          await broker.idle();
          const resume = broker.pauseForRestart();
          await manager.services.stop(lab, spec.service);
          active.throwIfAborted();
          assertLabEffect();
          await manager.services.start(lab, spec.service);
          endpoint = await ownedBrowserEndpoint(manager, lab, spec.service);
          resume(endpoint);
          evidence.serviceIdentities.push(productDigest(endpoint));
        }
        await executeJourneyStep(client, session, step, endpoint.origin, active, uploads);
        if (step.action === "screenshot") {
          const shot = z.object({ data: z.string().max(5592416) }).parse(await client.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }, session));
          evidence.artifacts.push(writeBrowserScreenshot(lab, checkId, Buffer.from(shot.data, "base64"), spec.max_screenshot_bytes));
        }
        await broker.idle();
        evidence.steps.push({ id: step.id, criterionIds: step.criterionIds, action: step.action, passed: true, durationMs: Date.now() - stepStarted, detail: "Declared browser action/assertion observed" });
      }
      catch (error) {
        evidence.steps.push({ id: step.id, criterionIds: step.criterionIds, action: step.action, passed: false, durationMs: Date.now() - stepStarted, detail: bounded(error instanceof Error ? error.message : "journey_step_failed") });
        throw error;
      }
    }
    await browser.assertOwned(active);
    await ownedBrowserEndpoint(manager, lab, spec.service, endpoint);
    if (productDigest(await journeySourceSnapshot(lab, active)) !== productDigest(sources))
      throw new Error("journey_source_revision_changed");
    evidence.fixtureAfterDigest = await journeyInputsDigest(lab, spec, active);
    evidence.resourceDigest = broker.resourceDigest();
    evidence.environmentDigest = journeyEnvironmentDigest(evidence);
    if (evidence.pageErrors.length || evidence.violations.length)
      throw new Error("journey_runtime_errors");
    evidence.status = "passed";
  }
  catch (error) {
    const code = error instanceof DockerBrowserError ? error.code : error instanceof Error ? error.message : "journey_failed";
    killed = signal?.aborted ? "cancelled" : active.aborted ? "journey_timeout_or_guard_failure" : code;
    evidence.status = signal?.aborted ? "cancelled" : !browser && error instanceof DockerBrowserError ? "unavailable" : "failed";
    if (evidence.violations.length < 20)
      evidence.violations.push(bounded(code));
    if (evidence.status === "unavailable")
      evidence.unknowns.push("Docker daemon/image or required contained browser runtime is unavailable; no host-browser fallback occurred.");
    if (code === "browser_docker_cleanup_unverified") {
      evidence.cleanup = "blocked";
      evidence.status = "failed";
      evidence.unknowns.push("Container creation/cleanup outcome uncertain; durable private generation retained for recovery.");
    }
  }
  finally {
    clearTimeout(timeout);
    controller.abort("journey_cleanup");
    client?.close();
    await Promise.allSettled([...events]);
    if (broker)
      await broker.idle().catch(() => { });
    if (browser)
      try {
        await browser.close();
      }
      catch {
        evidence.cleanup = "blocked";
        evidence.status = "failed";
        killed = "journey_cleanup_unverified";
        evidence.unknowns.push("Private exact-generation container ownership proof retained; cleanup requires reconciliation.");
      }
  }
  const result = BrowserJourneyEvidenceSchema.parse(evidence);
  manager.store.event(lab.id, "browser_journey_finished", { checkId, status: result.status, cleanup: result.cleanup, generation: result.isolation?.generation ?? null });
  return { exitCode: result.status === "passed" && result.cleanup === "complete" ? 0 : 1, killed, stdout: `Interactive journey ${result.status}: ${result.steps.filter(step => step.passed).length}/${spec.steps.length} declared steps observed.`, stderr: result.violations.join("\n"), durationMs: Date.now() - started, journey: result };
}
