"use client";

import { useState } from "react";
import { ActionStatus, useAction } from "./actions";
import { buttonClass } from "../ui";

export function LabRecipeEditor({ project, recipe, envKeys, promotion, maxActive, readOnly = false }: { project: string; recipe: unknown; envKeys: string[]; promotion: string; maxActive: number | null; readOnly?: boolean }) {
  const [text, setText] = useState(JSON.stringify(recipe ?? { ports: [], data: [], setup: [], services: {}, checks: {} }, null, 2));
  const [policy, setPolicy] = useState(promotion);
  const [maximum, setMaximum] = useState(maxActive === null ? "" : String(maxActive));
  const a = useAction();
  return <form className="space-y-4" onSubmit={async e => {
    e.preventDefault();
    let definition: unknown;
    try { definition = JSON.parse(text); } catch (err) { a.setError(`Recipe JSON: ${(err as Error).message}`); return; }
    await a.run(`/api/labs/recipe?project=${encodeURIComponent(project)}`, "PUT", { recipe: definition, promotion: policy, maxActive: maximum ? Number(maximum) : null }, { success: "Recipe saved. Existing labs keep their recipe snapshot; new labs use this definition." });
  }}>
    <p className="text-sm text-ink-2">Human-authored commands for isolated lab services, setup and checks. Saving never runs them. Use placeholders such as {"{repo.core}"}, {"{port.web}"} and {"{lab.data.db}"}.</p>
    <fieldset disabled={readOnly || a.busy} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-medium">Promotion policy<select className="field mt-1" value={policy} onChange={e => setPolicy(e.target.value)}><option value="manual">Manual review</option><option value="supervisor">Supervisor after checks</option><option value="auto">Automatic after checks</option></select></label>
      <label className="block text-sm font-medium">Retained lab limit<input className="field mt-1" type="number" min={1} max={100} value={maximum} placeholder="Use global limit" onChange={e => setMaximum(e.target.value)} /><span className="text-xs font-normal text-ink-3">Stopped and failed labs also count. Blank inherits the global limit.</span></label></div>
      <label className="block text-sm font-medium">Recipe definition (JSON)<textarea className="field mt-1 min-h-72 font-mono text-xs" rows={16} value={text} onChange={e => setText(e.target.value)} spellCheck={false} /></label>
      <button className={buttonClass("primary")} disabled={a.busy} type="submit">Save lab recipe</button>
    </fieldset>
    <p className="text-xs text-ink-3">Environment variables: {envKeys.length ? envKeys.join(", ") : "none configured"}. Values are preserved privately on save; edit them in your configuration file. Do not add an env field here.</p>
    {readOnly ? <p className="text-sm text-ink-3">This project's recipe is read only.</p> : null}
    <ActionStatus {...a} />
  </form>;
}
