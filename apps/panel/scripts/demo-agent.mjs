// Stand-in coding agent for the panel demo. Talks only to the per-job gateway SwitchYard gives it.
import { readFileSync, writeFileSync } from "node:fs";

const base = process.env.SWITCHYARD_BASE_URL;
const token = process.env.SWITCHYARD_JOB_TOKEN;

async function chat(content) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "agent-default", messages: [{ role: "user", content }] }),
  });
  return { status: res.status, text: await res.text() };
}

const plan = await chat("Plan: add a subtract() helper next to add() in src/app.ts.");
if (plan.status !== 200) {
  console.error(plan.text);
  process.exit(2);
}
const app = readFileSync("src/app.ts", "utf8");
writeFileSync("src/app.ts", `${app}\nexport function subtract(a: number, b: number) {\n  return a - b;\n}\n`);
console.log("Added subtract() to src/app.ts.");
