/**
 * HTML reduced to readable text without a parser dependency: scripts, styles, and other
 * non-content elements are dropped, block elements become line breaks, links keep their text,
 * entities are decoded, and whitespace is collapsed. Good enough for an agent to read a page; not
 * a renderer.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  laquo: "«",
  raquo: "»",
  times: "×",
  deg: "°",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const DROP = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "head", "nav", "footer", "form", "select", "button"];
const BLOCK = /<\/?(?:p|div|section|article|main|aside|header|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|blockquote|pre|figure|figcaption|address|details|summary)\b[^>]*>/gi;

export interface PageText {
  title: string;
  text: string;
  links: string[];
}

/** Readable text, the title, and up to `maxLinks` absolute http(s) links of an HTML page. */
export function htmlToText(html: string, baseUrl: string, maxLinks = 40): PageText {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() : "";
  let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
  for (const tag of DROP) s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  const links: string[] = [];
  for (const m of s.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    if (links.length >= maxLinks) break;
    try {
      const u = new URL(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""), baseUrl);
      u.hash = "";
      if ((u.protocol === "http:" || u.protocol === "https:") && !links.includes(u.href)) links.push(u.href);
    } catch {
      // Not a URL: skipped.
    }
  }
  s = s
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(BLOCK, "\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]*>/g, "");
  const text = decodeEntities(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links };
}
