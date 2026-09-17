import type { ProposedWrite } from "./types";

export const MAX_PROPOSED_FILES = 50;
export const MAX_FILE_BYTES = 1024 * 1024;

/** The model proposed something Kru won't show for approval. */
export class ProposedWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposedWriteError";
  }
}

/**
 * A normalized path inside the repo, or null when the path is unsafe:
 * absolute, drive-letter, climbing out with "..", or inside any .git folder.
 */
export function safeRepoPath(input: string): string | null {
  const path = input.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return null;
  if (parts.some((part) => part === ".." || part.toLowerCase() === ".git")) return null;
  return parts.join("/");
}

/**
 * Checks the agent's proposal before a person reviews it. Paths stay inside
 * the repo, one write per path (the last one wins), and size limits keep a
 * runaway model from flooding the pull request.
 */
export function validateProposedWrites(writes: ProposedWrite[]): ProposedWrite[] {
  const byPath = new Map<string, ProposedWrite>();
  for (const write of writes) {
    const path = safeRepoPath(write.path);
    if (!path) {
      throw new ProposedWriteError(
        `The model proposed an unsafe path: ${write.path.slice(0, 120)}`,
      );
    }
    if (Buffer.byteLength(write.content, "utf8") > MAX_FILE_BYTES) {
      throw new ProposedWriteError(`The proposed ${path} is larger than 1 MB`);
    }
    byPath.delete(path);
    byPath.set(path, {
      path,
      content: write.deleted ? "" : write.content,
      message: write.message.trim().slice(0, 200) || `Update ${path}`,
      ...(write.deleted ? { deleted: true } : {}),
      ...(write.diff ? { diff: write.diff } : {}),
    });
  }
  const result = [...byPath.values()];
  if (result.length === 0) {
    throw new ProposedWriteError("The model proposed no changes");
  }
  if (result.length > MAX_PROPOSED_FILES) {
    throw new ProposedWriteError(
      `The model proposed ${result.length} files; the limit is ${MAX_PROPOSED_FILES}`,
    );
  }
  return result;
}
