import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const modulePath = new URL("../evals/offload/lib/local-baseline.mjs", import.meta.url).href;
const { runDirectLocal, reviewLocalOffload } = await import(modulePath);
const source = { url: "http://127.0.0.1:41234", model: "fixture:8b" };
const raw = {
  kind: "scout", goal: "Find the fixture bug", prompt: "Explain the bug in ANSWER.md",
  contextFiles: ["src/code.ts"], allowedPaths: ["ANSWER.md"],
};
const temporary: string[] = [];
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-local-baseline-"));
  temporary.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src/code.ts"), "export const answer = 42;\n");
  writeFileSync(path.join(dir, "private.txt"), "PRIVATE_UNREQUESTED_SENTINEL");
  return dir;
}
function transport(content: unknown, extra = {}) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    done: true, message: { content: typeof content === "string" ? content : JSON.stringify(content) },
    prompt_eval_count: 101, eval_count: 17, ...extra,
  })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local supervisor baseline measurement", () => {
  it("uses one native request and only requested sources; never materializes its answer", async () => {
    const dir = fixture();
    const fetch = transport({ answer: "The fixture answer is 42." });
    expect(await runDirectLocal({ source, raw, dir })).toEqual({
      ok: true, answer: "The fixture answer is 42.", usage: { input: 101, output: 17 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:41234/api/chat");
    expect(options).toMatchObject({ method: "POST", redirect: "error" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const request = JSON.parse(options.body);
    expect(request).toMatchObject({ model: "fixture:8b", stream: false, think: false, options: { num_predict: 8192 } });
    expect(request.format.properties.answer.type).toBe("string");
    expect(options.body).toContain("export const answer = 42;");
    expect(options.body).not.toContain("PRIVATE_UNREQUESTED_SENTINEL");
    expect(readFileSync(path.join(dir, "src/code.ts"), "utf8")).toBe("export const answer = 42;\n");
  });

  it("returns scoped complete file contents without writing or executing them", async () => {
    const dir = fixture();
    const files = [{ path: "src/code.ts", content: "throw new Error('must never execute');" }];
    transport({ files });
    expect(await runDirectLocal({ source, raw: { ...raw, kind: "edit", allowedPaths: ["src/code.ts"] }, dir }))
      .toEqual({ ok: true, files, usage: { input: 101, output: 17 } });
    expect(readFileSync(path.join(dir, "src/code.ts"), "utf8")).toBe("export const answer = 42;\n");
  });

  it.each([
    { files: [{ path: "private.txt", content: "changed" }] },
    { files: [{ path: "../escape.ts", content: "changed" }] },
    { files: [{ path: "src/code.ts", content: "x" }, { path: "src/code.ts", content: "y" }] },
    { files: [{ path: "src/code.ts", content: "x" }], command: "npm test" },
  ])("rejects unscoped, duplicate or extra output: %j", async (output) => {
    transport(output);
    expect(await runDirectLocal({ source, raw: { ...raw, kind: "edit", allowedPaths: ["src/code.ts"] }, dir: fixture() }))
      .toMatchObject({ ok: false, usage: { input: 101, output: 17 } });
  });

  it("retains measured native token usage on malformed model JSON and performs no retry", async () => {
    const fetch = transport("```json\nnot JSON\n```");
    expect(await runDirectLocal({ source, raw, dir: fixture() }))
      .toMatchObject({ ok: false, usage: { input: 101, output: 17 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reviews supplied evidence in one request without reading a fixture directory", async () => {
    const fetch = transport({ recommendation: "accept", reason: "The independent grader passed." });
    expect(await reviewLocalOffload({ source, raw, report: "Worker summary", check: "PASS independent check", checkPassed: true }))
      .toEqual({ ok: true, recommendation: "accept", reason: "The independent grader passed.", usage: { input: 101, output: 17 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const input = JSON.parse(JSON.parse(fetch.mock.calls[0]![1].body).messages[1].content);
    expect(input).toMatchObject({ report: "Worker summary", check: "PASS independent check", checkPassed: true });
  });

  it("rejects invented recommendations while preserving native usage", async () => {
    transport({ recommendation: "probably fine" });
    expect(await reviewLocalOffload({ source, raw, report: "summary", check: "PASS", checkPassed: true }))
      .toMatchObject({ ok: false, usage: { input: 101, output: 17 } });
  });

  it.each(["https://127.0.0.1:41234", "http://localhost:41234", "http://127.0.0.1", "http://127.0.0.1:41234/path", "http://user@127.0.0.1:41234"])
    ("refuses non-explicit loopback origins: %s", async (url) => {
      const fetch = transport({ answer: "unused" });
      expect(await runDirectLocal({ source: { ...source, url }, raw, dir: fixture() })).toMatchObject({ ok: false, usage: null });
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each(["../private.txt", "src/../private.txt", "C:/private.txt", "/private.txt", "src\\code.ts"])
    ("refuses noncanonical requested paths before reading: %s", async (file) => {
      const fetch = transport({ answer: "unused" });
      expect(await runDirectLocal({ source, raw: { ...raw, contextFiles: [file] }, dir: fixture() })).toMatchObject({ ok: false });
      expect(fetch).not.toHaveBeenCalled();
    });

  it("bounds input files and streamed output", async () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "src/code.ts"), "x".repeat(131_073));
    const fetch = transport({ answer: "unused" });
    expect(await runDirectLocal({ source, raw, dir })).toMatchObject({ ok: false, reason: expect.stringContaining("bound") });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response("x".repeat(1_048_577)));
    expect(await reviewLocalOffload({ source, raw, report: "summary", check: "PASS", checkPassed: true }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("output bound") });
  });

  it("refuses linked fixture source directories", async () => {
    const dir = fixture();
    symlinkSync(path.join(dir, "src"), path.join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    const fetch = transport({ answer: "unused" });
    expect(await runDirectLocal({ source, raw: { ...raw, contextFiles: ["linked/code.ts"] }, dir }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("links are refused") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns HTTP and transport failures without retrying or inventing token usage", async () => {
    const fetch = transport({ answer: "unused" });
    fetch.mockResolvedValueOnce(new Response("failure", { status: 503 }));
    expect(await reviewLocalOffload({ source, raw, report: "summary", check: "PASS", checkPassed: true }))
      .toMatchObject({ ok: false, usage: null, reason: expect.stringContaining("503") });
    fetch.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    expect(await reviewLocalOffload({ source, raw, report: "summary", check: "PASS", checkPassed: true }))
      .toMatchObject({ ok: false, usage: null, reason: "Timed out" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not invent usage when native counters are unavailable and rejects incomplete responses", async () => {
    transport({ answer: "a" }, { prompt_eval_count: undefined });
    expect(await runDirectLocal({ source, raw, dir: fixture() })).toMatchObject({ ok: true, usage: null });
    transport({ answer: "a" }, { done: false });
    expect(await runDirectLocal({ source, raw, dir: fixture() })).toMatchObject({ ok: false, usage: { input: 101, output: 17 } });
  });
});
