import { diffLines } from "diff";
import { Marked, type Tokens } from "marked";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// Content is written by agents, so raw HTML is shown as text and only safe URL schemes are linked.
// Browsers drop tabs and newlines anywhere in a URL and control characters or spaces at its ends,
// so "java\tscript:" is javascript:. Check the URL the browser will see.
function safeUrl(href: string): string | null {
  const url = href.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  if (/^(https?:|mailto:)/i.test(url) || /^[/#?.]/.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }
  return null;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(url)}"${t} rel="noopener noreferrer nofollow">${inner}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const url = safeUrl(href);
      if (!url) return escapeHtml(text);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}

export type DiffLine = { kind: "add" | "del" | "same"; text: string };

/** Line diff, with long unchanged runs collapsed to a few lines of context. */
export function lineDiff(before: string, after: string, context = 3): (DiffLine | { kind: "gap"; count: number })[] {
  const lines: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const kind = part.added ? "add" : part.removed ? "del" : "same";
    const texts = part.value.replace(/\n$/, "").split("\n");
    for (const text of texts) lines.push({ kind, text });
  }
  const out: (DiffLine | { kind: "gap"; count: number })[] = [];
  const near = (i: number) => {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      if (lines[j]!.kind !== "same") return true;
    }
    return false;
  };
  let gap = 0;
  lines.forEach((line, i) => {
    if (line.kind === "same" && !near(i)) {
      gap++;
      return;
    }
    if (gap) out.push({ kind: "gap", count: gap });
    gap = 0;
    out.push(line);
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}
