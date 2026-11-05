"use client";

import { useEffect, useState } from "react";
import { Check, Copy, PlugZap, RefreshCw } from "lucide-react";
import { Badge, Card, CardHeader, Callout, buttonClass, cx, type Tone } from "../ui";
import { ActionStatus, callApi } from "./actions";
import type { ConnectionsView } from "@/lib/connections";

function CopyValue({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="min-w-0 space-y-1.5">
    <div className="text-xs font-medium text-ink-3">{label}</div>
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-3">
      <code className={cx("min-w-0 flex-1 break-all font-mono text-xs text-ink", multiline && "whitespace-pre-wrap")}>{value}</code>
      <button type="button" className={buttonClass("ghost", true)} aria-label={`Copy ${label}`} onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setError(null); setTimeout(() => setCopied(false), 2000); }
        catch { setError("Copy unavailable. Select and copy the value above."); }
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button>
    </div>
    {error ? <p role="status" className="text-xs text-ink-3">{error}</p> : null}
  </div>;
}

export function Connections({ initial }: { initial: ConnectionsView }) {
  const [view, setView] = useState(initial);
  const [project, setProject] = useState(initial.config.project ?? "");
  const [port, setPort] = useState(String(initial.config.port));
  const [profile, setProfile] = useState(initial.config.profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setInterval(async () => {
      const r = await callApi("/api/connections", "GET");
      if (live && r.ok && r.view) setView(r.view as ConnectionsView);
    }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const save = async (enabled: boolean, applySettings = true) => {
    setBusy(true); setError(null); setMessage(null);
    const settings = applySettings ? { project: project || null, port: Number(port), profile } : { project: view.config.project, port: view.config.port, profile: view.config.profile };
    const r = await callApi("/api/connections", "POST", { ...settings, enabled });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "Could not save connections."); return; }
    if (r.view) setView(r.view as ConnectionsView);
    setMessage(enabled ? "Enabled preference saved. Check the listener status below." : "Connections turned off. This preference is saved.");
  };
  const status = view.status;
  const tone: Tone = status === "running" ? "good" : status === "error" ? "bad" : status === "starting" ? "warn" : "neutral";
  const validProject = view.projects.some(p => p.slug === project);
  const dirty = project !== (view.config.project ?? "") || Number(port) !== view.config.port || profile !== view.config.profile;
  const field = "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink";
  return <div className="space-y-6">
    <Card>
      <CardHeader title={<><PlugZap size={16} /> External client connections <Badge tone={tone}>{status === "running" ? "Running" : status === "error" ? "Error" : status === "starting" ? "Starting" : "Off"}</Badge></>} description="Off by default. Your choice is saved and restored when this panel starts." actions={
        <button type="button" role="switch" aria-checked={view.config.enabled} aria-label="Enable external client connections" disabled={busy || (!view.config.enabled && !validProject)} onClick={() => void save(!view.config.enabled, !view.config.enabled)} className={cx("inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium disabled:opacity-50", view.config.enabled ? "border-accent/30 bg-accent-soft text-accent-ink" : "border-line-strong bg-surface-2 text-ink-2")}>
          {busy ? <RefreshCw size={14} className="animate-spin" /> : <span aria-hidden className={cx("h-3 w-3 rounded-full", view.config.enabled ? "bg-accent" : "bg-ink-3")} />}{view.config.enabled ? "Enabled" : "Disabled"}
        </button>
      } />
      <div className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Project</span><select value={project} onChange={e => setProject(e.target.value)} disabled={busy} className={field}><option value="">Choose a project</option>{view.projects.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Local port</span><input type="number" min={1024} max={65535} value={port} onChange={e => setPort(e.target.value)} disabled={busy} className={field} /></label>
          <label className="space-y-1.5 text-xs font-medium text-ink-2"><span>Routing profile</span><select value={profile} onChange={e => setProfile(e.target.value as typeof profile)} disabled={busy} className={field}>{view.profiles.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
        </div>
        {!validProject ? <p className="text-sm text-warn-ink">Choose an active project before enabling. Client requests use that project's routing, credentials and budgets.</p> : null}
        <div className="flex flex-wrap items-center gap-3"><button type="button" className={buttonClass("secondary")} disabled={busy || !dirty || (view.config.enabled && !validProject)} onClick={() => void save(view.config.enabled)}>Save settings</button><p className="text-xs text-ink-3">Saved preference: {view.config.enabled ? "enabled" : "disabled"}. Listener: {status}.</p></div>
        <ActionStatus error={error} message={message} />
        {view.error ? <Callout tone="bad" title="The connection is not listening">{view.error} Your saved preference remains enabled. Resolve the issue, then turn connections off and on to retry.</Callout> : null}
        <p className="text-xs leading-relaxed text-ink-3">Only apps on this computer can connect. Connections stay available while the panel is running; stopping the panel closes the listener and active requests. Enabling makes no model request. Requests follow the selected project's existing provider and paid-routing policy.</p>
      </div>
    </Card>
    <div className="grid gap-6 lg:grid-cols-2">
      <Card><CardHeader title="Ollama-compatible apps" description="Select Ollama as your app's provider, then paste this server address." /><div className="space-y-4 p-4"><CopyValue label="Ollama base URL" value={view.ollamaBaseUrl} /><CopyValue label="Model" value="meritrouter" /><p className="text-xs leading-relaxed text-ink-3">Model discovery and chat/generate are supported. This is a MeritRouter endpoint; model downloads and Ollama server management are unavailable.</p></div></Card>
      <Card><CardHeader title="OpenAI-compatible apps" description="Select a custom OpenAI-compatible provider in your editor or chat app." /><div className="space-y-4 p-4"><CopyValue label="OpenAI base URL" value={view.openaiBaseUrl} /><CopyValue label="Model" value="meritrouter" /><CopyValue label="API key (if required by your app)" value="meritrouter-local" /><p className="text-xs leading-relaxed text-ink-3">The local endpoint needs no provider key. Chat Completions and model discovery are supported; Responses and embeddings are unavailable.</p></div></Card>
    </div>
    <Card><CardHeader title="Try it from a terminal" description="This sends a model request using your selected project's policy and quota." /><div className="space-y-4 p-4"><CopyValue label="PowerShell command" multiline value={`$body = @{ model = 'meritrouter'; messages = @(@{ role = 'user'; content = 'Hello' }); stream = $false } | ConvertTo-Json -Depth 4\nInvoke-RestMethod -Uri '${view.openaiBaseUrl}/chat/completions' -Method Post -ContentType 'application/json' -Body $body`} /><CopyValue label="curl command (macOS / Linux)" multiline value={`curl ${view.openaiBaseUrl}/chat/completions -H "Content-Type: application/json" -d '{"model":"meritrouter","messages":[{"role":"user","content":"Hello"}],"stream":false}'`} /><p className="text-xs leading-relaxed text-ink-3">Streaming clients receive compatible frames after the model finishes (buffered delivery). Client tool definitions and results can be forwarded; tools execute in your client. The service listens only on this computer; browser access also depends on the app's origin and browser policy. Compatibility depends on the endpoints your app uses.</p></div></Card>
  </div>;
}
