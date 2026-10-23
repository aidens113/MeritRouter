import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readSync, rmSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { z } from "zod";
import { minimalEnv } from "../runners/coding/process.js";
import { captureOwnedProcessTree, HOST_MARKER, inspectLabListeners, stopOwnedProcess } from "./process-ownership.js";
import { labOwnedPath } from "./paths.js";
import type { LabRecord } from "./store.js";
import { browserCheckDirectory } from "./browser-artifacts.js";
const HOST = `// ${HOST_MARKER}
const {spawn}=require('node:child_process');
const cfg=JSON.parse(process.env.MERITROUTER_BROWSER_COMMAND);delete process.env.MERITROUTER_BROWSER_COMMAND;
const child=spawn(cfg.executable,cfg.args,{stdio:['ignore','ignore','inherit'],windowsHide:true});
child.on('error',error=>{console.error(error.message);process.exit(1)});child.on('close',code=>{console.error('browser exit '+code);process.exit(code??1)});
`;
export interface OwnedBrowser {
  pid: number;
  url: string;
  profile: string;
  close(): Promise<void>;
}
/** A dead-end proxy plus offline CDP mode are separate guards from request interception. */
export async function launchOwnedBrowser(lab: LabRecord, checkId: string, executable: string, signal: AbortSignal, unmanaged: () => void, started?: (pid: number) => void): Promise<OwnedBrowser> {
  if (!existsSync(executable))
    throw new Error("declared browser executable is unavailable");
  const directory = browserCheckDirectory(lab, checkId);
  const profile = labOwnedPath(path.resolve(lab.root, "../../.."), path.join(directory, "profile"));
  mkdirSync(profile, { recursive: true });
  const local = path.join(profile, "AppData", "Local");
  const roaming = path.join(profile, "AppData", "Roaming");
  mkdirSync(local, { recursive: true });
  mkdirSync(roaming, { recursive: true });
  const connections = new Set<net.Socket>();
  const proxy = net.createServer(socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    unmanaged();
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw new Error("browser network guard did not bind");
  const token = randomBytes(24).toString("hex");
  const args = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-component-extensions-with-background-pages", "--disable-background-mode",
    "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync",
    "--disable-client-side-phishing-detection", "--disable-default-apps", "--disable-notifications", "--disable-breakpad",
    "--disable-quic", "--dns-prefetch-disable", "--no-pings", "--disable-renderer-backgrounding",
    "--disable-features=MediaRouter,OptimizationHints,Prerender2,SpeculationRulesPrefetch,WebTransport,DirectSockets",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    `--proxy-server=http://127.0.0.1:${address.port}`, "--proxy-bypass-list=<-loopback>",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ];
  const child = spawn(process.execPath, ["-e", HOST, "--", `--sy-lab-token=${token}`], {
    detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "ignore", "pipe"], cwd: directory,
    env: minimalEnv({ HOME: profile, USERPROFILE: profile, LOCALAPPDATA: local, APPDATA: roaming, MERITROUTER_BROWSER_COMMAND: JSON.stringify({ executable, args }) }),
  });
  child.unref();
  let diagnostics = "";
  child.stderr?.on("data", chunk => {
    diagnostics = (diagnostics + String(chunk)).slice(-4096);
  });
  let spawnError = false;
  child.once("error", () => {
    spawnError = true;
  });
  const pid = child.pid;
  if (pid)
    started?.(pid);
  const proof = path.join(directory, "browser.process-tree.json");
  const close = async () => {
    for (const socket of connections)
      socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    if (pid)
      await stopOwnedProcess(pid, token, proof);
    const ownedProfile = labOwnedPath(path.resolve(lab.root, "../../.."), profile);
    rmSync(ownedProfile, { recursive: true, force: true });
  };
  try {
    if (!pid)
      throw new Error("browser wrapper did not start");
    const activePort = path.join(profile, "DevToolsActivePort");
    while (!existsSync(activePort)) {
      if (signal.aborted || spawnError || child.exitCode !== null)
        throw new Error(`browser did not become ready: ${diagnostics.slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const ownedPortFile = labOwnedPath(path.resolve(lab.root, "../../.."), activePort);
    const fd = openSync(ownedPortFile, "r");
    const control = Buffer.alloc(1025);
    let length: number;
    try {
      length = readSync(fd, control, 0, control.length, 0);
    }
    finally {
      closeSync(fd);
    }
    if (length > 1024)
      throw new Error("browser control file exceeded its limit");
    const [portText, route] = control.subarray(0, length).toString("utf8").trim().split(/\r?\n/);
    const port = z.coerce.number().int().min(1024).max(65535).parse(portText);
    z.string().regex(/^\/devtools\/browser\/[a-zA-Z0-9-]+$/).parse(route);
    const listeners = await inspectLabListeners(pid, token, [port]);
    if (!listeners.some(listener => listener.port === port))
      throw new Error("browser debugger port ownership was not verified");
    await captureOwnedProcessTree(pid, token, proof);
    return { pid, url: `ws://127.0.0.1:${port}${route}`, profile, close };
  }
  catch (error) {
    await close();
    throw error;
  }
}
