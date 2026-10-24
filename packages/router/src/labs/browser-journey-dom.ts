import { z } from "zod";
import type { BrowserPipeMethod } from "./browser-pipe.js";
import type { BrowserAssertionSchema } from "./browser-schema.js";
import type { BrowserJourneyStepSchema } from "./browser-journey-schema.js";
/** Internal typed CDP adapter, not a model-facing arbitrary evaluate/script interface. */
export interface JourneyProtocol {
  call(method: BrowserPipeMethod, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}
async function node(client: JourneyProtocol, session: string, selector: string): Promise<number> {
  const document = z.object({ root: z.object({ nodeId: z.number().int() }) }).parse(await client.call("DOM.getDocument", { depth: 0 }, session));
  return z.object({ nodeId: z.number().int() }).parse(await client.call("DOM.querySelector", { nodeId: document.root.nodeId, selector }, session)).nodeId;
}
export async function journeyAssertion(client: JourneyProtocol, session: string, assertion: z.infer<typeof BrowserAssertionSchema>): Promise<boolean> {
  const id = await node(client, session, assertion.kind === "title_contains" ? "title" : assertion.selector);
  if (!id)
    return false;
  if (assertion.kind === "exists")
    return true;
  const result = z.object({ node: z.unknown() }).parse(await client.call("DOM.describeNode", { nodeId: id, depth: -1 }, session));
  const pending: unknown[] = [result.node];
  let text = "", nodes = 0;
  while (pending.length && text.length < 16384) {
    if (++nodes > 20000)
      throw new Error("journey_dom_node_limit");
    const current = z.object({ nodeType: z.number().int(), nodeValue: z.string().max(2 * 1024 * 1024), children: z.array(z.unknown()).max(20000).optional() }).parse(pending.pop());
    if (current.nodeType === 3 || current.nodeType === 4)
      text += current.nodeValue.slice(0, 16384 - text.length);
    if (current.children)
      pending.push(...[...current.children].reverse());
  }
  return text.includes(assertion.text);
}
async function wait(delay: number, signal: AbortSignal) { signal.throwIfAborted(); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, delay); function stop() { clearTimeout(timer); reject(new Error("journey_cancelled")); } signal.addEventListener("abort", stop, { once: true }); }); }
/** Real input events exercise application handlers; DOM mutation is never substituted for behavior. */
export async function executeJourneyStep(client: JourneyProtocol, session: string, step: z.infer<typeof BrowserJourneyStepSchema>, origin: string, signal: AbortSignal, uploads: Record<string, string> = {}): Promise<void> {
  signal.throwIfAborted();
  if (step.action === "assert") {
    if (!await journeyAssertion(client, session, step.assertion))
      throw new Error("journey_assertion_failed");
    return;
  }
  if (step.action === "wait_for") {
    const until = Date.now() + step.timeout_ms;
    do {
      signal.throwIfAborted();
      if (await journeyAssertion(client, session, step.assertion))
        return;
      await wait(100, signal);
    } while (Date.now() < until);
    throw new Error("journey_wait_assertion_failed");
  }
  if (step.action === "navigate") {
    const target = new URL(step.path, origin);
    if (target.origin !== origin)
      throw new Error("journey_navigation_scope_denied");
    const result = z.object({ errorText: z.string().optional() }).parse(await client.call("Page.navigate", { url: target.href }, session));
    if (result.errorText)
      throw new Error("journey_navigation_failed");
    return;
  }
  if (step.action === "reload") {
    await client.call("Page.reload", { ignoreCache: true }, session);
    return;
  }
  if (step.action === "viewport") {
    await client.call("Emulation.setDeviceMetricsOverride", { width: step.width, height: step.height, mobile: step.mobile, deviceScaleFactor: 1 }, session);
    return;
  }
  if (step.action === "restart_service")
    return; // Runtime owns declared-service authority/lifecycle.
  if (step.action === "key") {
    await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: step.key }, session);
    await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: step.key }, session);
    return;
  }
  if (step.action === "screenshot")
    return; // Runtime owns artifact validation/persistence.
  const id = await node(client, session, step.selector);
  if (!id)
    throw new Error("journey_selector_missing");
  if (step.action === "upload") {
    const file = uploads[step.fixture];
    if (!file || !/^\/tmp\/uploads\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(file))
      throw new Error("journey_upload_fixture_unavailable");
    await client.call("DOM.setFileInputFiles", { nodeId: id, files: [file] }, session);
    return;
  }
  await client.call("DOM.scrollIntoViewIfNeeded", { nodeId: id }, session);
  if (step.action === "click") {
    const result = z.object({ model: z.object({ content: z.array(z.number().finite()).length(8) }) }).parse(await client.call("DOM.getBoxModel", { nodeId: id }, session));
    const q = result.model.content, x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
    if (x < 0 || y < 0)
      throw new Error("journey_target_not_visible");
    await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, session);
    await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, session);
    return;
  }
  await client.call("DOM.focus", { nodeId: id }, session);
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }, session);
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }, session);
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", windowsVirtualKeyCode: 8 }, session);
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", windowsVirtualKeyCode: 8 }, session);
  await client.call("Input.insertText", { text: step.text }, session);
}
