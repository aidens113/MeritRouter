/**
 * The working-document protocol (adopted from FluxIQ's agent-working-doc-protocol): header block,
 * an authoritative `Current State` rewritten in place, an append-only `Work Ledger` whose entries
 * record real validation, and `Open Questions`. Workers write only their own report files.
 */

export const HEADER_FIELDS = ["Status", "Status detail", "Created", "Last updated", "Owner", "Scope", "Paired document", "Related"] as const;
export const STATUS_VALUES = ["Active", "Paused", "Blocked", "Complete", "Superseded", "Archived", "Unclassified"] as const;
export const OUTCOMES = ["Accepted", "Partial", "Reverted", "Blocked"] as const;
export const LEDGER_FIELDS = ["Agent", "Changed", "Why", "Validation", "Outcome", "Follow-up"] as const;
export const REPORT_SECTIONS = ["Outcome", "What changed and why", "Commands run and observed results", "Not verified", "Open questions or contradictions found"] as const;

/** "Worker reported success" is not validation (FluxIQ audit rule). */
const HEARSAY = /(reported success|\bworkers? (reported|said|claimed)\b|\bagent (reported|said|claimed)\b)/i;

export interface Section {
  heading: string;
  /** Line index of the heading. */
  start: number;
  /** Line index after the section's last line. */
  end: number;
  body: string;
}

export interface ParsedDoc {
  title: string | null;
  header: Partial<Record<(typeof HEADER_FIELDS)[number], string>>;
  sections: Section[];
  lines: string[];
}

export function parseDoc(text: string): ParsedDoc {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const title = lines.find((l) => /^# /.test(l))?.slice(2).trim() ?? null;
  const header: ParsedDoc["header"] = {};
  const titleIdx = lines.findIndex((l) => /^# /.test(l));
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) {
      if (Object.keys(header).length) break;
      continue;
    }
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(l);
    if (!m || !(HEADER_FIELDS as readonly string[]).includes(m[1]!)) break;
    header[m[1] as (typeof HEADER_FIELDS)[number]] = m[2]!;
  }
  const sections: Section[] = [];
  lines.forEach((l, i) => {
    if (/^## /.test(l)) sections.push({ heading: l.slice(3).trim(), start: i, end: lines.length, body: "" });
  });
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    s.end = sections[i + 1]?.start ?? lines.length;
    // A trailing `---` separator belongs between sections, not to the body.
    s.body = lines.slice(s.start + 1, s.end).join("\n").replace(/^\n+|\n+$/g, "").replace(/\n*---$/, "").replace(/\n+$/, "");
  }
  return { title, header, sections, lines };
}

export function section(doc: ParsedDoc, heading: string): Section | undefined {
  return doc.sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase());
}

/** Replace a section body (creating the section before `beforeHeading`, or at the end). */
export function replaceSection(text: string, heading: string, body: string, beforeHeading?: string): string {
  const doc = parseDoc(text);
  const s = section(doc, heading);
  const bodyLines = body.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "").split("\n");
  const lines = [...doc.lines];
  if (s) {
    // Keep the `---` separator that followed the section.
    const old = lines.slice(s.start + 1, s.end).map((l) => l.trim()).filter(Boolean);
    const separator = old[old.length - 1] === "---";
    lines.splice(s.start, s.end - s.start, `## ${heading}`, "", ...bodyLines, "", ...(separator ? ["---", ""] : []));
  } else {
    const before = beforeHeading ? section(doc, beforeHeading) : undefined;
    if (before) lines.splice(before.start, 0, `## ${heading}`, "", ...bodyLines, "", "---", "");
    else lines.push("", `## ${heading}`, "", ...bodyLines, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Append a block at the end of a section (creating it if missing). */
export function appendToSection(text: string, heading: string, block: string, beforeHeading?: string): string {
  const doc = parseDoc(text);
  const s = section(doc, heading);
  if (!s) return replaceSection(text, heading, block, beforeHeading);
  return replaceSection(text, heading, `${s.body}${s.body ? "\n\n" : ""}${block.replace(/\n+$/, "")}`);
}

export function setHeaderField(text: string, field: (typeof HEADER_FIELDS)[number], value: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${field}:`));
  if (idx >= 0) lines[idx] = `${field}: ${value}`;
  return lines.join("\n");
}

export function validateHeader(doc: ParsedDoc): string[] {
  const issues: string[] = [];
  if (!doc.title) issues.push("missing '# Title' line");
  for (const f of HEADER_FIELDS) if (doc.header[f] === undefined) issues.push(`header is missing '${f}:'`);
  const status = doc.header.Status;
  if (status && !(STATUS_VALUES as readonly string[]).includes(status)) issues.push(`Status '${status}' must be one of ${STATUS_VALUES.join(", ")}`);
  return issues;
}

export function validateCurrentState(body: string, maxLines: number): string[] {
  const n = body.split("\n").length;
  return n > maxLines ? [`Current State has ${n} lines; the limit is ${maxLines}. Fold history into the ledger or archive.`] : [];
}

export interface LedgerFields {
  title: string;
  date?: string;
  agent: string;
  changed: string;
  why: string;
  validation: string;
  outcome: (typeof OUTCOMES)[number];
  followUp: string;
}

export function formatLedgerEntry(f: LedgerFields, today = new Date().toISOString().slice(0, 10)): string {
  return [
    `### ${f.date ?? today} — ${f.title}`,
    `- Agent: ${f.agent}`,
    `- Changed: ${f.changed}`,
    `- Why: ${f.why}`,
    `- Validation: ${f.validation}`,
    `- Outcome: ${f.outcome}`,
    `- Follow-up: ${f.followUp}`,
  ].join("\n");
}

export function validateLedgerEntry(entry: string): string[] {
  const issues: string[] = [];
  const lines = entry.trim().split("\n");
  if (!/^### \d{4}-\d{2}-\d{2} [—-] .+/.test(lines[0] ?? "")) issues.push("ledger entry must start with '### YYYY-MM-DD — <title>'");
  if (lines.length > 15) issues.push(`ledger entry has ${lines.length} lines; keep it under 15`);
  for (const f of LEDGER_FIELDS) if (!lines.some((l) => l.startsWith(`- ${f}:`))) issues.push(`ledger entry needs '- ${f}:'`);
  const validation = lines.find((l) => l.startsWith("- Validation:"))?.slice("- Validation:".length).trim() ?? "";
  if (validation && HEARSAY.test(validation)) issues.push("Validation must record a command and its observed result, not what an agent reported");
  if (validation && !/`[^`]+`|not validated/i.test(validation)) issues.push("Validation needs the exact `command` -> observed result, or 'not validated' and why");
  const outcome = lines.find((l) => l.startsWith("- Outcome:"))?.slice("- Outcome:".length).trim();
  if (outcome && !(OUTCOMES as readonly string[]).includes(outcome)) issues.push(`Outcome must be one of ${OUTCOMES.join(", ")}`);
  return issues;
}

export function ledgerEntryCount(doc: ParsedDoc): number {
  const s = section(doc, "Work Ledger");
  return s ? (s.body.match(/^### /gm) ?? []).length : 0;
}

export interface ReportFields {
  label: string;
  outcome: "Done" | "Partial" | "Blocked";
  outcomeContext: string;
  changed: string;
  commands: string;
  notVerified: string;
  questions: string;
}

export function formatReport(f: ReportFields): string {
  return [
    `# Report: ${f.label}`,
    "## Outcome",
    `${f.outcome}: ${f.outcomeContext}`,
    "## What changed and why",
    f.changed || "Nothing changed.",
    "## Commands run and observed results",
    f.commands || "None.",
    "## Not verified",
    f.notVerified || "Nothing noted.",
    "## Open questions or contradictions found",
    f.questions || "None.",
    "",
  ].join("\n");
}

export function validateReport(text: string): string[] {
  const doc = parseDoc(text);
  const issues: string[] = [];
  if (!/^Report: /.test(doc.title ?? "")) issues.push("report must start with '# Report: <agent-label>'");
  for (const h of REPORT_SECTIONS) if (!section(doc, h)) issues.push(`report needs a '## ${h}' section`);
  const outcome = section(doc, "Outcome")?.body.trim() ?? "";
  if (outcome && !/^(Done|Partial|Blocked)\b/.test(outcome)) issues.push("Outcome must start with Done, Partial, or Blocked");
  return issues;
}

export function workingDocTemplate(f: { title: string; statusDetail: string; owner: string; scope: string; related?: string; paired?: string; currentState: string }, today = new Date().toISOString().slice(0, 10)): string {
  return `# ${f.title}

Status: Active
Status detail: ${f.statusDetail}
Created: ${today}
Last updated: ${today}
Owner: ${f.owner}
Scope: ${f.scope}
Paired document: ${f.paired ?? "none"}
Related: ${f.related ?? "none"}

## Current State

${f.currentState.trim()}

---

## Worker Briefs

---

## Work Ledger

---

## Open Questions

None yet.
`;
}

/**
 * The job's team channel, mirrored into its working document: append-only, one entry per post.
 * Post text is other agents' output, so it is quoted line by line (a post can never start a
 * heading, a ledger entry, or a separator of the document).
 */
export const TEAM_CHANNEL_SECTION = "Team Channel";

export interface ChannelEntryFields {
  id: number;
  at: number;
  kind: string;
  author: string;
  authorTask: string | null;
  refs: string[];
  text: string;
}

export function formatChannelEntry(f: ChannelEntryFields): string {
  const head = `- #${f.id} ${new Date(f.at).toISOString().slice(0, 16).replace("T", " ")} ${f.kind} by ${f.author}${f.authorTask ? ` (task ${f.authorTask})` : ""}; ${f.refs.length ? `refs ${f.refs.join(", ")}` : "job-wide"}`;
  const quoted = f.text.replace(/\r\n?/g, "\n").split("\n").map((l) => `  > ${l}`.trimEnd());
  return [head, ...quoted].join("\n");
}

/** Ids of the channel entries a Team Channel section already holds. */
export function channelEntryIds(sectionBody: string): Set<number> {
  return new Set([...sectionBody.matchAll(/^- #(\d+) /gm)].map((m) => Number(m[1])));
}

export function formatBrief(b: { label: string; repository: string; task: string; requiredReads: string; owns: string; mustNotTouch: string; done: string; reportTo: string }): string {
  return [
    `### Brief: ${b.label}`,
    `- Repository: ${b.repository}`,
    `- Task: ${b.task}`,
    `- Required reads: ${b.requiredReads}`,
    `- Owns (may edit): ${b.owns}`,
    `- Must not touch: ${b.mustNotTouch}`,
    `- Definition of done: ${b.done}`,
    `- Report to: ${b.reportTo}`,
  ].join("\n");
}
