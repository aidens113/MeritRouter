import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { docker } = vi.hoisted(() => ({ docker: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: docker }));
const { gradeCodingFixture } = await import(new URL("../evals/offload/lib/container-grader.mjs", import.meta.url).href);
const fixtureSource = fileURLToPath(new URL("../evals/offload/fixture", import.meta.url));
let fixture: string;

beforeEach(() => {
  docker.mockReset();
  docker.mockReturnValue({ status: 0, stdout: "PASS: trusted check passed\n", stderr: "" });
  fixture = mkdtempSync(path.join(tmpdir(), "meritrouter-grader-test-"));
  cpSync(fixtureSource, fixture, { recursive: true });
});
afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("isolated coding fixture grader", () => {
  it("mounts only staged regular input and trusted assets, with all containment flags", () => {
    vi.stubEnv("OPENAI_API_KEY", "private-test-value");
    vi.stubEnv("DOCKER_HOST", "tcp://external.invalid:2375");
    writeFileSync(path.join(fixture, ".env"), "PRIVATE=do not stage");
    const stagingPaths: string[] = [];
    docker.mockImplementation((command: string, args: string[], options: { env: Record<string, string>; timeout: number; windowsHide: boolean }) => {
      expect(command).toBe("docker");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env).not.toHaveProperty("DOCKER_HOST");
      expect(options.windowsHide).toBe(true);
      if (args[0] === "run") {
        expect(args).toEqual(expect.arrayContaining(["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "65534:65534", "--cpus=1", "--memory=512m", "--memory-swap=512m", "--pids-limit=64"]));
        expect(args.slice(-3)).toEqual(["node", "node:22-already-local", "/trusted/entry.mjs"]);
        expect(options.timeout).toBe(120_000);
        const mounts = args.filter((arg) => arg.startsWith("type=bind,"));
        expect(mounts).toHaveLength(2);
        for (const mount of mounts) {
          expect(mount).toMatch(/,readonly$/);
          const source = mount.split(",source=")[1]!.split(",target=")[0]!;
          stagingPaths.push(source);
          expect(source.startsWith(tmpdir())).toBe(true);
          expect(source.startsWith(fixture)).toBe(false);
          expect(lstatSync(source).isSymbolicLink()).toBe(false);
        }
        const input = stagingPaths[0]!;
        const trusted = stagingPaths[1]!;
        expect(readdirSync(input).sort()).toEqual(["package.json", "src", "tests", "tsconfig.json"]);
        expect(existsSync(path.join(trusted, "node_modules/typescript/lib/tsc.js"))).toBe(true);
        expect(existsSync(path.join(trusted, "node_modules/@types/node/index.d.ts"))).toBe(true);
        expect(existsSync(path.join(trusted, "node_modules/undici-types/index.d.ts"))).toBe(true);
        expect(readFileSync(path.join(trusted, "evals/offload/checks/03-rename.mjs"), "utf8")).toContain("legacySlugify");
        expect(readFileSync(path.join(trusted, "entry.mjs"), "utf8")).toContain("Grader requires Node 22");
      }
      return { status: 0, stdout: "PASS: actual grader evidence\n", stderr: "" };
    });
    expect(gradeCodingFixture("03-rename", fixture, { image: "node:22-already-local" })).toEqual({ ok: true, output: "PASS: actual grader evidence\n" });
    expect(docker).toHaveBeenCalledTimes(2);
    const runArgs = docker.mock.calls[0]![1] as string[];
    const runName = runArgs[runArgs.indexOf("--name") + 1];
    expect(docker.mock.calls[1]![1]).toEqual(["rm", "--force", runName]);
    for (const source of stagingPaths) expect(existsSync(source)).toBe(false);
  });

  it.each([
    ["01-scout", "node:22", /Unsupported/],
    ["03-rename", "", /explicit/],
    ["03-rename", "--privileged", /explicit/],
    ["03-rename", "node:22 --network=host", /explicit/],
  ])("refuses unsupported task/image %s %s before invoking Docker", (task, image, message) => {
    expect(gradeCodingFixture(task, fixture, { image })).toMatchObject({ ok: false, output: expect.stringMatching(message) });
    expect(docker).not.toHaveBeenCalled();
  });

  it("refuses the repository, relative input and non-temp paths", () => {
    for (const input of [fixtureSource, ".", path.parse(fixture).root]) {
      expect(gradeCodingFixture("03-rename", input, { image: "node:22" }).ok).toBe(false);
    }
    expect(docker).not.toHaveBeenCalled();
  });

  it("refuses junctions before copying model-controlled input", () => {
    const link = path.join(fixture, "src/escape");
    symlinkSync(path.join(fixture, "tests"), link, process.platform === "win32" ? "junction" : "dir");
    expect(gradeCodingFixture("03-rename", fixture, { image: "node:22" })).toMatchObject({ ok: false, output: expect.stringMatching(/Links are not permitted/) });
    expect(docker).not.toHaveBeenCalled();
  });

  it("refuses oversized fixture input", () => {
    writeFileSync(path.join(fixture, "src/large.ts"), Buffer.alloc(4 * 1024 * 1024 + 1));
    expect(gradeCodingFixture("03-rename", fixture, { image: "node:22" })).toMatchObject({ ok: false, output: expect.stringMatching(/byte limit/) });
    expect(docker).not.toHaveBeenCalled();
  });

  it.each([
    { status: 1, stdout: "FAIL: negative cents case", stderr: "" },
    { status: null, stdout: "", stderr: "", error: new Error("spawn docker ENOENT") },
    { status: null, stdout: "", stderr: "", error: new Error("spawn docker ETIMEDOUT") },
  ])("fails closed on grader/engine errors and always cleans its named container", (failure) => {
    docker.mockReturnValueOnce(failure).mockReturnValueOnce({ status: 1, stdout: "", stderr: "Error: No such container: owned-name" });
    expect(gradeCodingFixture("05-bugfix", fixture, { image: "node:22" }).ok).toBe(false);
    expect(docker).toHaveBeenCalledTimes(2);
    expect(docker.mock.calls[1]![1][0]).toBe("rm");
  });

  it("fails closed when named container cleanup cannot be verified", () => {
    docker.mockReturnValueOnce({ status: 0, stdout: "PASS", stderr: "" }).mockReturnValueOnce({ status: 1, stdout: "", stderr: "engine unavailable" });
    expect(gradeCodingFixture("07-refactor", fixture, { image: "node:22" })).toMatchObject({ ok: false, output: expect.stringMatching(/cleanup unverified/) });
  });
});
