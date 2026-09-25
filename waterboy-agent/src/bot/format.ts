/** Turn model markdown into something that reads well as a text message. */
export function toPlainText(md: string): string {
  let s = md.replace(/\r\n/g, "\n");
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code: string) => code.trimEnd());
  s = s.replace(/`([^`\n]+)`/g, "$1");
  s = s.replace(/^#{1,6}\s+(.*)$/gm, "$1");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/__([^_\n]+)__/g, "$1");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2");
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 $2");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) => (t === u ? u : `${t} (${u})`));
  s = s.replace(/^\s*[-*]\s+/gm, "• ");
  s = s.replace(/^\s*\|?\s*:?-{3,}.*$/gm, ""); // table separator rows
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Split long replies at paragraph / line / sentence boundaries. */
export function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.4) cut = window.lastIndexOf("\n");
    if (cut < max * 0.4) cut = window.lastIndexOf(". ") + 1;
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
