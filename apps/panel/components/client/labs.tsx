"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionStatus, useAction } from "./actions";
import { ConfirmDialog } from "./confirm-dialog";
import { buttonClass } from "../ui";
import { projectBase } from "@/lib/links";

const endpoint = (project: string, name?: string) => `/api/labs${name ? `/${encodeURIComponent(name)}` : ""}?project=${encodeURIComponent(project)}`;

export function CreateLabForm({ project, configured }: { project: string; configured: boolean }) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const a = useAction();
  const router = useRouter();
  return <form className="space-y-3" onSubmit={async e => {
    e.preventDefault();
    const r = await a.run(endpoint(project), "POST", { name, goal }, { success: "Creation queued. A Labs supervisor will process it." });
    if (r.ok) router.push(`${projectBase(project)}/labs/${encodeURIComponent(name)}`);
  }}>
    <fieldset disabled={!configured || a.busy} className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm font-medium">Lab name<input className="field mt-1" value={name} onChange={e => setName(e.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,40}" maxLength={41} placeholder="checkout-fix" /></label>
      <label className="text-sm font-medium">Goal<input className="field mt-1" value={goal} onChange={e => setGoal(e.target.value)} maxLength={16000} placeholder="What you are testing" /></label>
      <button className={buttonClass("primary")} disabled={!name || a.busy} type="submit">Queue lab creation</button>
    </fieldset>
    <p className="text-xs text-ink-3">Creates isolated branches, data and ports from the project recipe. Services start only when you choose Start.</p>
    <ActionStatus {...a} />
  </form>;
}

export function LabControls({ project, name, checks, services, disabled = false }: { project: string; name: string; checks: string[]; services: string[]; disabled?: boolean }) {
  const a = useAction();
  const [confirmation, setConfirmation] = useState<"promote" | "destroy" | "refresh" | null>(null);
  const [reason, setReason] = useState("");
  const [service, setService] = useState("");
  const run = (action: string, extra: Record<string, unknown> = {}) => a.run(endpoint(project, name), "POST", { action, ...extra }, { success: `${action} queued. Inspect the operation below for its outcome.` });
  return <div className="space-y-3">
    <fieldset disabled={disabled || a.busy} className="flex flex-wrap gap-2">
      <button className={buttonClass("primary")} onClick={() => void run("start")}>Start</button>
      <button className={buttonClass("secondary")} onClick={() => void run("stop")}>Stop</button>
      <select aria-label="Service to restart" className="field w-auto" value={service} onChange={e => setService(e.target.value)}><option value="">All services</option>{services.map(s => <option key={s}>{s}</option>)}</select>
      <button className={buttonClass("secondary")} onClick={() => void run("restart", service ? { service } : {})}>Restart</button>
      {checks.map(check => <button key={check} className={buttonClass("secondary")} onClick={() => void run("check", { check })}>Run {check}</button>)}
      <button className={buttonClass("secondary")} onClick={() => setConfirmation("refresh")}>Refresh from target</button>
      <button className={buttonClass("secondary")} onClick={() => { setReason(""); setConfirmation("promote"); }}>Promote</button>
      <button className={buttonClass("danger")} onClick={() => setConfirmation("destroy")}>Destroy</button>
    </fieldset>
    <ActionStatus {...a} />
    <ConfirmDialog open={confirmation !== null} onClose={() => setConfirmation(null)} title={confirmation === "promote" ? "Promote this lab?" : confirmation === "destroy" ? "Destroy this lab?" : "Refresh this lab?"}
      description={confirmation === "promote" ? "Queue reviewed lab changes for promotion to the target branches. Checks and conflict rules still apply." : confirmation === "destroy" ? "Stop owned services and remove clean lab worktrees and data. Dirty worktrees are refused; lab branches remain." : "Bring target changes into the lab. Services may restart; conflicts are reported without silently discarding your work."}
      confirmLabel={`Queue ${confirmation ?? "operation"}`} tone={confirmation === "destroy" ? "danger" : "default"} confirmDisabled={confirmation === "promote" && !reason.trim()}
      onConfirm={async () => (await run(confirmation!, confirmation === "promote" ? { reason } : {})).ok}>
      {confirmation === "promote" ? <label className="block text-sm">Review reason<textarea className="field mt-1" value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} rows={3} required /></label> : null}
      <ActionStatus {...a} />
    </ConfirmDialog>
  </div>;
}

export function LabLogViewer({ project, name, services }: { project: string; name: string; services: string[] }) {
  const [service, setService] = useState(services[0] ?? "");
  const [text, setText] = useState<string | null>(null);
  const a = useAction();
  return <div className="space-y-3"><div className="flex flex-wrap gap-2">
    <select aria-label="Service logs" className="field w-auto" value={service} onChange={e => { setService(e.target.value); setText(null); }}>{services.map(s => <option key={s}>{s}</option>)}</select>
    <button className={buttonClass("secondary")} disabled={!service || a.busy} onClick={async () => { const r = await a.run(`${endpoint(project, name).replace("?", "/logs?")}&service=${encodeURIComponent(service)}`, "GET", undefined, { refresh: false }); if (r.ok) setText(String(r.log ?? "")); }}>Load latest logs</button>
  </div><ActionStatus {...a} />{text !== null ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink-2">{text || "No log output yet."}</pre> : <p className="text-sm text-ink-3">Load the latest 200 lines. Runtime tokens and configured environment values are redacted.</p>}</div>;
}


export function LabPromotionDetail({ project, name, operationId }: { project: string; name: string; operationId: string }) {
  const a = useAction();
  const [detail, setDetail] = useState<ReturnType<typeof import("meritrouter").insights.labPromotionView> | null>(null);
  return <div className="mt-3 space-y-2"><button className={buttonClass("secondary")} disabled={a.busy} onClick={async () => {
    const r = await a.run(`${endpoint(project, name)}&operationId=${encodeURIComponent(operationId)}`, "GET", undefined, { refresh: false });
    if (r.ok) setDetail(r as unknown as NonNullable<typeof detail>);
  }}>Inspect promotion evidence</button><ActionStatus {...a} />{detail ? <div className="space-y-3 text-sm">
    <p>Promotion {detail.state} ({detail.policy})</p>
    {Object.entries(detail.heads).map(([alias, sha]) => <p className="break-all" key={alias}>{alias}: checked head <code>{sha}</code>; target <code>{detail.targets[alias] ?? "unavailable"}</code></p>)}
    {detail.checks.map((check, i) => <p className="break-all" key={i}>{check.name}: {check.passed ? "passed" : "failed"} at {check.revision}</p>)}
    {detail.manualCommands.length ? <div><p>Manual promotion instructions. Review the checked revisions before running these commands.</p><pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-xs">{detail.manualCommands.join("\n")}</pre></div> : null}
    {detail.instructionsOmitted ? <p>Some oversized instructions were omitted. Inspect local supervisor logs.</p> : null}
    {Object.entries(detail.conflicts).map(([alias, paths]) => <p className="break-words" key={alias}>Conflicts in {alias}: {paths.join(", ")}</p>)}
    {detail.error ? <p className="text-bad-ink">{detail.error}</p> : null}
  </div> : null}</div>;
}
