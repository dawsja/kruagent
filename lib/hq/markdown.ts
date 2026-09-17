/*
 * A small Markdown reader for what agents say while they work: paragraphs,
 * headings, lists, quotes, fenced code, and inline code, bold, italics and
 * links. It builds a tree rather than HTML, so the run log renders it as
 * React elements and the watch terminal as ANSI, and nothing an agent
 * writes is ever injected as markup.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold" | "italic"; children: Inline[] }
  | { kind: "link"; text: string; href: string };

export type ListItem = { depth: number; marker: string; inlines: Inline[] };

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" };

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|(?<![\w*])\*(?=[^*\s])([^*\n]*?[^*\s])\*(?![\w*])|(?<![\w_])_(?=[^_\s])([^_\n]*?[^_\s])_(?![\w_])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "text", text: text.slice(last, index) });
    const [, ticks, code, bold1, bold2, italic1, italic2, linkText, href] = match;
    if (ticks) out.push({ kind: "code", text: ticks.length > 1 ? code.trim() : code });
    else if (bold1 ?? bold2) out.push({ kind: "bold", children: parseInline(bold1 ?? bold2) });
    else if (italic1 ?? italic2) out.push({ kind: "italic", children: parseInline(italic1 ?? italic2) });
    else out.push({ kind: "link", text: linkText, href });
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      const close = new RegExp(`^\\s*${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`);
      for (i += 1; i < lines.length && !close.test(lines[i]); i += 1) body.push(lines[i]);
      blocks.push({ kind: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, inlines: parseInline(heading[2]) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const previous = blocks.at(-1);
      const list =
        previous?.kind === "list" && previous.ordered === ordered
          ? previous
          : (blocks[blocks.push({ kind: "list", ordered, items: [] }) - 1] as Extract<Block, { kind: "list" }>);
      list.items.push({
        depth: Math.floor(item[1].replace(/\t/g, "  ").length / 2),
        marker: ordered ? item[2].replace(")", ".") : "•",
        inlines: parseInline(item[3]),
      });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const previous = blocks.at(-1);
      if (previous?.kind === "quote") {
        previous.inlines.push({ kind: "text", text: "\n" }, ...parseInline(quote[1]));
      } else {
        blocks.push({ kind: "quote", inlines: parseInline(quote[1]) });
      }
      continue;
    }
    // An indented line right after a list item continues that item.
    const previous = blocks.at(-1);
    if (!paragraph.length && previous?.kind === "list" && /^\s+\S/.test(line) && lines[i - 1]?.trim()) {
      previous.items.at(-1)?.inlines.push({ kind: "text", text: " " }, ...parseInline(line.trim()));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** The words of some inline Markdown, without its markers. */
export function plainInline(inlines: Inline[]): string {
  return inlines
    .map((inline) => ("children" in inline ? plainInline(inline.children) : inline.text))
    .join("");
}

const ESC = "\x1b[";
/** Kru's orange, for markers and headings in the terminal. */
const ACCENT = `${ESC}38;2;255;106;51m`;
const DEFAULT_FG = `${ESC}39m`;

function inlineAnsi(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case "text":
          return inline.text;
        case "code":
          return `${ESC}36m${inline.text}${DEFAULT_FG}`;
        case "bold":
          return `${ESC}1m${inlineAnsi(inline.children)}${ESC}22m`;
        case "italic":
          return `${ESC}3m${inlineAnsi(inline.children)}${ESC}23m`;
        case "link":
          return `${ESC}4m${inline.text}${ESC}24m ${ESC}2m(${inline.href})${ESC}22m`;
      }
    })
    .join("");
}

/** Markdown as terminal text: bold, italics, colors and box-drawing, lines ending in "\n". */
export function markdownToAnsi(source: string): string {
  const out: string[] = [];
  for (const block of parseMarkdown(source)) {
    switch (block.kind) {
      case "paragraph":
        out.push(inlineAnsi(block.inlines));
        break;
      case "heading":
        out.push(`${ESC}1m${ACCENT}${inlineAnsi(block.inlines)}${DEFAULT_FG}${ESC}22m`);
        break;
      case "list":
        out.push(
          block.items
            .map((item) => `${"  ".repeat(item.depth + 1)}${ACCENT}${item.marker}${DEFAULT_FG} ${inlineAnsi(item.inlines)}`)
            .join("\n"),
        );
        break;
      case "quote":
        out.push(
          inlineAnsi(block.inlines)
            .split("\n")
            .map((line) => `${ESC}2m▎${ESC}22m ${ESC}3m${line}${ESC}23m`)
            .join("\n"),
        );
        break;
      case "code": {
        const label = block.lang ? ` ${block.lang}` : "";
        const body = block.text
          .split("\n")
          .map((line) => `${ESC}2m│${ESC}22m ${ESC}33m${line}${DEFAULT_FG}`)
          .join("\n");
        out.push(`${ESC}2m╭─${label}${ESC}22m\n${body}\n${ESC}2m╰─${ESC}22m`);
        break;
      }
      case "rule":
        out.push(`${ESC}2m${"─".repeat(24)}${ESC}22m`);
        break;
    }
  }
  return out.length ? `${out.join("\n\n")}\n` : "";
}
