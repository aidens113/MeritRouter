"use client";

import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { Badge, Card, CardHeader, buttonClass, cx, type Tone } from "../ui";
import { ActionStatus, callApi } from "./actions";
import type { ConnectionsView } from "@/lib/connections";

type Settings = ConnectionsView["config"];
type Mode = Settings["default_mode"];
type ConnectionPatch = Partial<Settings> & { rotate_token?: boolean };
const MODES: Array<{ id: Mode; label: string }> = [
  { id: "direct", label: "Direct" }, { id: "agent", label: "Agent" }, { id: "team", label: "Team" },
];

function CopyValue({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="min-w-0 space-y-1.5">
    <div className="text-xs font-medium text-ink-3">{label}</div>
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2">
      {multiline ? <code className="min-w-0 flex-1 whitespace-pre-wrap break-all p-1 font-mono text-xs text-ink">{value}</code> : <input aria-label={label} readOnly value={value} className="min-w-0 flex-1 bg-transparent p-1 font-mono text-xs text-ink outline-none" onFocus={event => event.target.select()} />}
      <button type="button" className={buttonClass("ghost", true)} aria-label={`Copy ${label}`} onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setError(null); setTimeout(() => setCopied(false), 2000); }
        catch { setError("Select the value to copy it."); }
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button>
    </div>
    {error ? <p role="status" className="text-xs text-ink-3">{error}</p> : null}
  </div>;
}

export function Connections({ initial }: { initial: ConnectionsView }) {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState(initial.config);
  const [host, setHost] = useState(initial.config.host);
  const [protocol, setProtocol] = useState<"ollama" | "openai">("ollama");
  const [mode, setMode] = useState<Mode>(initial.config.default_mode);
  const [advanced, setAdvanced] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const change = (patch: Partial<Settings>) => setDraft(current => ({ ...current, ...patch }));
  useEffect(() => {
    let live = true;
    const timer = setInterval(async () => {
      const response = await callApi("/api/connections", "GET");
      if (live && response.ok && response.view) setView(response.view as ConnectionsView);
    }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const save = async (patch: ConnectionPatch, success: string) => {
    setBusy(true); setError(null); setMessage(null);
    const response = await callApi("/api/connections", "POST", patch);
    setBusy(false);
    if (!response.ok) { setError(response.error ?? "Could not save connections."); return; }
    if (response.view) setView(response.view as ConnectionsView);
    const { rotate_token: _rotate, ...settings } = patch;
    if (typeof response.access_token === "string") setAccessToken(response.access_token);
    change(settings); setMessage(success);
  };
  const selectedProject = view.projects.find(project => project.slug === draft.project);
  const agentEnabled = draft.enabled_modes.includes("agent");
  const teamEnabled = draft.enabled_modes.includes("team");
  const codingAgent = agentEnabled && view.codingAgentProfiles.includes(draft.agent_profile);
  const writable = selectedProject?.repositories.filter(repo => repo.writable && draft.repositories.includes(repo.alias)) ?? [];
  const validWritable = !codingAgent || (draft.agent_writable_repository ? writable.some(repo => repo.alias === draft.agent_writable_repository) : writable.length === 1);
  const validAgents = !draft.project || !(agentEnabled || teamEnabled) || Boolean(selectedProject && draft.repositories.length && draft.repositories.every(alias => selectedProject.repositories.some(repo => repo.alias === alias)) && (!agentEnabled || view.agentProfiles.includes(draft.agent_profile)) && (!teamEnabled || view.teamAvailable) && validWritable);
  const modePatch = {
    enabled_modes: draft.enabled_modes, default_mode: draft.default_mode,
    project: draft.project, repositories: draft.repositories,
    agent_profile: draft.agent_profile, agent_writable_repository: draft.agent_writable_repository,
    agent_max_model_requests: draft.agent_max_model_requests, agent_timeout_seconds: draft.agent_timeout_seconds,
    agent_max_paid_usd: draft.agent_max_paid_usd, agent_max_active_jobs: draft.agent_max_active_jobs,
  };
  const modesDirty = Object.entries(modePatch).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(view.config[key as keyof typeof modePatch]));
  const toggleMode = (value: Mode) => {
    setDraft(current => {
      const enabled_modes = current.enabled_modes.includes(value) ? current.enabled_modes.filter(item => item !== value) : [...current.enabled_modes, value];
      if (!enabled_modes.length) return current;
      return { ...current, enabled_modes, default_mode: enabled_modes.includes(current.default_mode) ? current.default_mode : enabled_modes[0]! };
    });
    if (value !== "direct") setAdvanced(true);
  };
  const selectedMode = view.config.enabled_modes.includes(mode) ? mode : view.config.default_mode;
  const model = `meritrouter-${selectedMode}`;
  const endpoint = protocol === "ollama" ? view.ollamaBaseUrl : view.openaiBaseUrl;
  const needsKey = view.tokenRequired || view.tokenConfigured;
  const authentication = needsKey ? " -Headers @{ Authorization = 'Bearer YOUR_CONNECTION_KEY' }" : "";
  const jobMode = selectedMode !== "direct" ? selectedMode : view.config.enabled_modes.includes("agent") ? "agent" : "team";
  const jobBody = JSON.stringify({ mode: jobMode, goal: "Inspect the repository and report an improvement", repository_aliases: view.config.repositories, acceptance_criteria: ["Describe findings and verification"] });
  const field = "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink";
  const tone: Tone = view.status === "running" ? "good" : view.status === "error" ? "bad" : view.status === "starting" ? "warn" : "neutral";
  const keyControls = <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-ink-2">Access key {view.tokenConfigured ? <Badge>Configured</Badge> : null}</span><button type="button" className={buttonClass("ghost", true)} disabled={busy} onClick={() => void save({ rotate_token: true }, "Access key generated. Copy it before leaving this page.")}>{view.tokenConfigured ? "Generate new key" : "Generate key"}</button></div>
    {accessToken ? <><CopyValue label="New access key" value={accessToken} /><p className="text-xs text-ink-3">Shown once. Copy it now; it cannot be recovered after reload.</p></> : <p className="text-xs text-ink-3">{view.tokenConfigured ? "Use your saved key, or generate a new one if you no longer have it." : "A key is generated automatically when you save a network address."}</p>}
  </div>;
  return <div className="max-w-[960px] space-y-5">
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">Connection <Badge tone={tone}>{view.status === "running" ? "Running" : view.status === "starting" ? "Starting" : view.status === "error" ? "Needs attention" : "Off"}</Badge></span>} actions={<button type="button" role="switch" aria-checked={view.config.enabled} aria-label="Enable external client connections" disabled={busy} onClick={() => void save({ enabled: !view.config.enabled }, view.config.enabled ? "Connections turned off." : "Connections enabled.")} className={cx(buttonClass(view.config.enabled ? "primary" : "secondary"), "min-w-24")}>{busy ? <RefreshCw size={14} className="animate-spin" /> : null}{view.config.enabled ? "On" : "Turn on"}</button>} />
      <div className="space-y-3 p-4">
        <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Host / IP</span><input aria-label="Host / IP" value={host} onChange={event => setHost(event.target.value)} disabled={busy} spellCheck={false} className={field} /></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Port</span><input aria-label="Port" type="number" min={1024} max={65535} value={draft.port} onChange={event => change({ port: Number(event.target.value) })} disabled={busy} className={field} /></label>
          <button type="button" className={buttonClass("secondary")} disabled={busy || (draft.port === view.config.port && host === view.config.host)} onClick={() => void save({ host, port: draft.port }, "Connection address saved.")}>Save address</button>
        </div>
        {view.error ? <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad-ink">{view.error}</p> : null}
        {needsKey ? <div className="border-t border-line pt-3">{keyControls}</div> : <details><summary className="cursor-pointer text-xs text-ink-3">Access key (optional on this computer)</summary><div className="pt-3">{keyControls}</div></details>}
        <ActionStatus error={error} message={message} />
        <p className="text-xs text-ink-3">Saved across restarts. Available while the panel is running.</p>
      </div>
    </Card>
    <Card>
      <CardHeader title="Connect your app" />
      <div className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>API format</span><select value={protocol} onChange={event => setProtocol(event.target.value as typeof protocol)} className={field}><option value="ollama">Ollama</option><option value="openai">OpenAI-compatible</option></select></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Mode</span><select value={selectedMode} onChange={event => setMode(event.target.value as Mode)} className={field}>{MODES.filter(item => view.config.enabled_modes.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        </div>
        <CopyValue label="Server URL" value={endpoint} />
        <CopyValue label="Model" value={model} />
        {protocol === "openai" && !needsKey ? <CopyValue label="API key (if your app asks)" value="meritrouter-local" /> : null}
        {protocol === "openai" && needsKey ? accessToken ? <CopyValue label="API key" value={accessToken} /> : <p className="text-xs text-ink-3">Use your configured access key as the API key. Generate a new key above if you no longer have it.</p> : null}
        {protocol === "ollama" && needsKey ? <p className="text-xs text-ink-3">Add <code>Authorization: Bearer &lt;access key&gt;</code> in your app's custom headers.</p> : null}
        <p className="text-xs text-ink-3">{selectedMode === "direct" ? "Direct replies use automatic model and key routing. Your app runs its tools." : view.config.project && view.config.repositories.length ? "Agent modes return a queued job acknowledgment. A running MeritRouter worker executes the job." : "Choose an agent project and repositories in Advanced agent settings before submitting work."} Model <code>meritrouter</code> uses your saved default: {view.config.default_mode}.</p>
        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><fieldset className="flex flex-wrap gap-4"><legend className="mb-2 text-xs font-medium text-ink-3">Available modes</legend>{MODES.map(item => <label key={item.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled_modes.includes(item.id)} disabled={busy || (draft.enabled_modes.length === 1 && draft.enabled_modes[0] === item.id)} onChange={() => toggleMode(item.id)} />{item.label}</label>)}</fieldset><label className="flex items-center gap-2 text-xs text-ink-3">Default<select value={draft.default_mode} onChange={event => change({ default_mode: event.target.value as Mode })} disabled={busy} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">{MODES.filter(item => draft.enabled_modes.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
          <div className="flex flex-wrap items-center gap-3"><button type="button" className={buttonClass("secondary", true)} disabled={busy || !modesDirty || !validAgents} onClick={() => void save(modePatch, "Mode settings saved.")}>Save modes</button>{!validAgents ? <p className="text-xs text-warn-ink">Finish the agent settings below to enable agent modes.</p> : null}</div>
        </div>
      </div>
    </Card>
    <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)} className="rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink">Advanced agent settings</summary>
      <div className="space-y-4 border-t border-line p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Agent project (optional)</span><select value={draft.project ?? ""} onChange={event => change({ project: event.target.value || null, repositories: [], agent_writable_repository: null })} disabled={busy} className={field}><option value="">Not configured</option>{view.projects.map(project => <option key={project.slug} value={project.slug}>{project.name}</option>)}</select></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Worker profile</span><select value={draft.agent_profile} onChange={event => change({ agent_profile: event.target.value as typeof draft.agent_profile })} disabled={busy} className={field}>{view.agentProfiles.map(profile => <option key={profile} value={profile}>{profile}</option>)}</select></label>
        </div>
        <fieldset><legend className="mb-2 text-xs font-medium text-ink-3">Allowed repositories</legend><div className="flex flex-wrap gap-4">{selectedProject?.repositories.map(repo => <label key={repo.alias} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.repositories.includes(repo.alias)} disabled={busy} onChange={() => setDraft(current => { const repositories = current.repositories.includes(repo.alias) ? current.repositories.filter(alias => alias !== repo.alias) : [...current.repositories, repo.alias]; return { ...current, repositories, agent_writable_repository: current.agent_writable_repository && repositories.includes(current.agent_writable_repository) ? current.agent_writable_repository : null }; })} />{repo.alias}{!repo.writable ? <span className="text-xs text-ink-3">read only</span> : null}</label>)}</div></fieldset>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {codingAgent ? <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Writable repository</span><select value={draft.agent_writable_repository ?? ""} onChange={event => change({ agent_writable_repository: event.target.value || null })} disabled={busy} className={field}><option value="">Use the sole writable repository</option>{writable.map(repo => <option key={repo.alias} value={repo.alias}>{repo.alias}</option>)}</select></label> : null}
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Model requests per job</span><input type="number" min={1} value={draft.agent_max_model_requests} onChange={event => change({ agent_max_model_requests: Number(event.target.value) })} disabled={busy} className={field} /></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Root / worker timeout (seconds)</span><input type="number" min={1} value={draft.agent_timeout_seconds} onChange={event => change({ agent_timeout_seconds: Number(event.target.value) })} disabled={busy} className={field} /></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Paid limit per job (USD)</span><input type="number" min={0} step="0.01" value={draft.agent_max_paid_usd} onChange={event => change({ agent_max_paid_usd: Number(event.target.value) })} disabled={busy} className={field} /></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Active jobs</span><input type="number" min={1} value={draft.agent_max_active_jobs} onChange={event => change({ agent_max_active_jobs: Number(event.target.value) })} disabled={busy} className={field} /></label>
        </div>
        {teamEnabled && !view.teamAvailable ? <p className="text-xs text-warn-ink">Team mode needs a configured supervise profile.</p> : null}
        {!validWritable ? <p className="text-xs text-warn-ink">Choose a writable repository for coding agents.</p> : null}
        <p className="text-xs text-ink-3">Agent work uses this project and its allowed repositories. Direct replies do not need a project. Team children keep their task deadlines; cancel the job to stop the team.</p>
        <button type="button" className={buttonClass("secondary", true)} disabled={busy || !modesDirty || !validAgents} onClick={() => void save(modePatch, "Agent settings saved.")}>Save agent settings</button>
      </div>
    </details>
    <details className="rounded-xl border border-line bg-surface"><summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink">Examples and job controls</summary><div className="space-y-4 border-t border-line p-4">
      <CopyValue label="Chat request (PowerShell)" multiline value={`$body = @{ model = '${model}'; messages = @(@{ role = 'user'; content = 'Hello' }); stream = $false } | ConvertTo-Json -Depth 4\nInvoke-RestMethod -Uri '${view.openaiBaseUrl}/chat/completions' -Method Post -ContentType 'application/json'${authentication} -Body $body`} />
      {view.config.project && view.config.repositories.length && view.config.enabled_modes.some(item => item !== "direct") ? <><CopyValue label="Submit and check a job (PowerShell)" multiline value={`$job = Invoke-RestMethod -Uri '${view.ollamaBaseUrl}/api/jobs' -Method Post -ContentType 'application/json'${authentication} -Body '${jobBody}'\n$headers = @{ Authorization = "Bearer $($job.access_token)" }\nInvoke-RestMethod -Uri ('${view.ollamaBaseUrl}' + $job.status_url) -Headers $headers`} /><CopyValue label="Cancel the job" multiline value={`Invoke-RestMethod -Uri ('${view.ollamaBaseUrl}' + $job.cancel_url) -Method Post -Headers $headers`} /><p className="text-xs text-ink-3">Keep the returned job token. Status and cancellation require it; an acknowledgment is not a finished result. Submitted jobs continue when the connection is turned off.</p></> : null}
      <p className="text-xs text-ink-3">Supports model discovery, chat and Ollama generate. Direct streaming is buffered. Other APIs depend on client compatibility.</p>
    </div></details>
  </div>;
}
