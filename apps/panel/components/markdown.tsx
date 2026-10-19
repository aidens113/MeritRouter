import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./ui";

/**
 * Small, safe markdown renderer for brain documents. It builds React elements only (no HTML
 * injection): raw HTML in a document is shown as text, and links are limited to http(s) and
 * brain-relative paths. Supports front matter, headings, paragraphs, lists, task boxes, block
 * quotes, fenced code, pipe tables, rules, and inline code/bold/italic/links.
 */
export function Markdown({ text, basePath }: { text: string; basePath: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => key++;

  // YAML front matter.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      const rows = lines.slice(1, end).filter((l) => l.trim());
      out.push(
        <dl key={k()} className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
          {rows.map((r, j) => {
            const m = /^([\w.-]+):\s*(.*)$/.exec(r);
            return m ? (
              <div key={j} className="contents">
                <dt className="text-ink-3">{m[1]}</dt>
                <dd className="break-words text-ink-2">{m[2]}</dd>
              </div>
            ) : (
              <dd key={j} className="col-span-2 text-ink-2">
                {r}
              </dd>
            );
          })}
        </dl>,
      );
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^(\s*)(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[2]!)) body.push(lines[i++]!);
      i++;
      out.push(
        <pre key={k()} className="my-3 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink-2">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const cls = level === 1 ? "mt-1 mb-3 text-xl font-semibold" : level === 2 ? "mt-6 mb-2 border-b border-line pb-1 text-base font-semibold" : "mt-4 mb-1.5 text-sm font-semibold";
      const Tag = (`h${Math.min(level + 1, 6)}`) as "h2";
      out.push(
        <Tag key={k()} id={slug(h[2]!)} className={cx("text-ink", cls)}>
          {inline(h[2]!, basePath)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={k()} className="my-4 border-line" />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={k()} className="my-3 border-l-2 border-line-strong pl-3 text-ink-2">
          <Markdown text={body.join("\n")} basePath={basePath} />
        </blockquote>,
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        <div key={k()} className="my-3 overflow-x-auto rounded-lg border border-line">
          <table className="data-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, basePath)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j}>{inline(r[j] ?? "", basePath)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) {
          items.push(m[3]!);
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
          items[items.length - 1] += ` ${lines[i]!.trim()}`;
          i++;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={k()} className={cx("my-2 space-y-1 pl-5 text-ink", ordered ? "list-decimal" : "list-disc")}>
          {items.map((it, j) => {
            const task = /^\[( |x|X)\]\s+(.*)$/.exec(it);
            return (
              <li key={j} className={task ? "list-none -ml-5 flex items-start gap-2" : undefined}>
                {task ? <input type="checkbox" checked={task[1] !== " "} readOnly disabled className="mt-1" aria-label={task[1] !== " " ? "done" : "not done"} /> : null}
                <span>{inline(task ? task[2]! : it, basePath)}</span>
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    // Paragraph: consecutive non-blank lines that start no other block.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i]!) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]!)) para.push(lines[i++]!);
    // A block of "Field: value" lines (a working document's header) reads better as a table.
    if (para.length >= 2 && para.every((l) => /^[A-Z][A-Za-z ]{1,30}:\s/.test(l))) {
      out.push(
        <dl key={k()} className="my-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-line px-3 py-2 text-sm">
          {para.map((l, j) => {
            const idx = l.indexOf(":");
            return (
              <div key={j} className="contents">
                <dt className="text-ink-3">{l.slice(0, idx)}</dt>
                <dd className="min-w-0 break-words text-ink">{inline(l.slice(idx + 1).trim(), basePath)}</dd>
              </div>
            );
          })}
        </dl>,
      );
      continue;
    }
    if (!para.length) {
      // A line no block rule accepted (e.g. a lone table row): show it as text.
      para.push(lines[i++]!);
    }
    out.push(
      <p key={k()} className="my-2 leading-relaxed text-ink">
        {inline(para.join(" "), basePath)}
      </p>,
    );
  }
  return <div className="min-w-0 break-words text-sm">{out}</div>;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Resolve a relative link against the document's folder; null when it leaves the brain. */
function resolveBrain(basePath: string, href: string): string | null {
  const dir = basePath.split("/").slice(0, -1);
  const parts = href.split("#")[0]!.split("/");
  const stack = href.startsWith("/") ? [] : [...dir];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (!stack.length) return null;
      stack.pop();
    } else stack.push(p);
  }
  return stack.join("/");
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, basePath: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) out.push(<code key={n++} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em] text-ink-2">{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={n++} className="font-semibold">{inline(s.slice(2, -2), basePath)}</strong>);
    else if (m[3]) out.push(<em key={n++}>{inline(s.slice(1, -1), basePath)}</em>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)!;
      const label = lm[1]!;
      const href = lm[2]!;
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a key={n++} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-ink underline decoration-accent/40 hover:decoration-accent">
            {label}
          </a>,
        );
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("brain:")) {
        // Any other scheme (javascript:, data:, file:) is shown as text, never linked.
        out.push(`${label} (${href})`);
      } else if (href.startsWith("#")) {
        out.push(
          <a key={n++} href={href} className="text-accent-ink underline decoration-accent/40">
            {label}
          </a>,
        );
      } else {
        const target = href.startsWith("brain:") ? resolveBrain("", `/${href.slice(6)}`) : resolveBrain(basePath, href);
        out.push(
          target ? (
            <Link key={n++} href={`/brain?path=${encodeURIComponent(target)}`} className="text-accent-ink underline decoration-accent/40 hover:decoration-accent">
              {label}
            </Link>
          ) : (
            label
          ),
        );
      }
    }
    last = m.index! + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
