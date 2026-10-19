// Stand-in coding agent for tests. Talks only to the job gateway it is given.
import { readFileSync, writeFileSync } from "node:fs";

const base = process.env.SWITCHYARD_BASE_URL;
const token = process.env.SWITCHYARD_JOB_TOKEN;
const mode = process.argv[2] ?? "good";

async function chat(content) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "anything-the-agent-wants", stream: mode === "stream", messages: [{ role: "user", content }] }),
  });
  return { status: res.status, text: await res.text() };
}

// Leaked or inherited provider keys must not be present.
if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.FREELLMAPI_API_KEY) {
  console.log("LEAKED_CREDENTIALS");
  process.exit(3);
}

if (mode === "loop") {
  for (let i = 0; i < 50; i++) {
    const r = await chat(`call ${i}`);
    if (r.status !== 200) {
      console.log(`stopped after ${i} admitted calls: ${r.status}`);
      break;
    }
  }
  writeFileSync("src/app.ts", readFileSync("src/app.ts", "utf8") + "\n// partial work\n");
  // Keep running until the runner kills us.
  await new Promise((r) => setTimeout(r, 30000));
}

const first = await chat("plan");
if (first.status !== 200) {
  console.error(first.text);
  process.exit(2);
}
if (mode === "stream" && !first.text.includes("data: [DONE]")) process.exit(4);
const title = await chat("title for the session");
if (title.status !== 200) process.exit(2);

if (mode === "fixrange") {
  writeFileSync("src/range.js", readFileSync("src/range.js", "utf8").replace("i <= end", "i < end"));
  process.exit(0);
}
if (mode === "noop") process.exit(0);

const app = readFileSync("src/app.ts", "utf8");
writeFileSync("src/app.ts", app + "\nexport function subtract(a: number, b: number) {\n  return a - b;\n}\n");
if (mode === "scope") writeFileSync("README.md", "# changed outside scope\n");
if (mode === "tests") writeFileSync("src/app.test.ts", "// weakened test\n");
console.log("Added subtract().");
