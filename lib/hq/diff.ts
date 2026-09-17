/** How a unified-diff line should be shown. Shared by the review UI and tests. */
export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Counts added and removed lines, for a quick "+12 −3" summary. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    const kind = diffLineKind(line);
    if (kind === "add") added += 1;
    else if (kind === "del") removed += 1;
  }
  return { added, removed };
}

/** One displayable row of a unified diff, with GitHub-style old/new line numbers. */
export type DiffRow =
  | { kind: "add" | "del" | "context"; oldLine?: number; newLine?: number; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "note"; text: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Turns a unified diff into rows for the review UI. Git's file header lines
 * are dropped (the file path is shown elsewhere); lines that are not part of
 * a hunk body, like "\ No newline at end of file" or a truncation marker,
 * become notes without line numbers.
 */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      if (diffLineKind(line) !== "meta" && line !== "") rows.push({ kind: "note", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    } else {
      rows.push({ kind: "note", text: line });
    }
  }
  return rows;
}
