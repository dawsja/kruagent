import type { ChatAttachment } from "../types.ts";

/*
 * Files you attach to a message in the Team room: screenshots, mockups,
 * PDFs, notes. The rules are kept pure so the composer and the server agree
 * on them and they can be tested. The server checks a file's bytes, not
 * just the type the browser claims.
 */

export type AttachmentKind = "image" | "pdf" | "text";

/** Files per message. */
export const MAX_ATTACHMENTS = 4;
/** Per kind: images match the model APIs' own cap. */
export const MAX_BYTES: Record<AttachmentKind, number> = {
  image: 5 * 1024 * 1024,
  pdf: 8 * 1024 * 1024,
  text: 256 * 1024,
};
/** All of a message's files; the upload must fit under Next's 10 MB proxy buffer. */
export const MAX_TOTAL_BYTES = 9 * 1024 * 1024;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "json", "log", "yaml", "yml"] as const;

/** For the file picker's `accept`. */
export const ACCEPT = [...IMAGE_TYPES, "application/pdf", ...TEXT_EXTENSIONS.map((ext) => `.${ext}`)].join(",");

function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** What a file is from its name and claimed type, or null when it isn't accepted. */
export function kindFromName(name: string, type: string): { kind: AttachmentKind; mediaType: string } | null {
  const clean = type.toLowerCase().split(";")[0].trim();
  const ext = extension(name);
  if ((IMAGE_TYPES as readonly string[]).includes(clean)) return { kind: "image", mediaType: clean };
  const image = IMAGE_EXTENSIONS[ext];
  if (image) return { kind: "image", mediaType: image };
  if (clean === "application/pdf" || ext === "pdf") return { kind: "pdf", mediaType: "application/pdf" };
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { kind: "text", mediaType: ext === "md" || ext === "markdown" ? "text/markdown" : "text/plain" };
  }
  return null;
}

export function kindOf(mediaType: string): AttachmentKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  return "text";
}

/** The type the bytes actually are, for the kinds that have a signature. */
export function sniffMediaType(data: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return "image/webp";
  }
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** A name safe to show and to send in a header: no paths, no control characters. */
export function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 120);
  return clean || "attachment";
}

/**
 * The first reason a set of files can't be sent, from names, types and
 * sizes alone: what the composer can tell before uploading.
 */
export function checkFiles(files: readonly { name: string; type: string; size: number }[]): string | null {
  if (files.length > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} files to a message.`;
  let total = 0;
  for (const file of files) {
    const found = kindFromName(file.name, file.type);
    if (!found) return `${cleanName(file.name)} isn't an image, PDF or text file.`;
    if (file.size === 0) return `${cleanName(file.name)} is empty.`;
    if (file.size > MAX_BYTES[found.kind]) {
      return `${cleanName(file.name)} is ${formatBytes(file.size)}; ${found.kind === "image" ? "images" : found.kind === "pdf" ? "PDFs" : "text files"} can be up to ${formatBytes(MAX_BYTES[found.kind])}.`;
    }
    total += file.size;
  }
  if (total > MAX_TOTAL_BYTES) return `The files come to ${formatBytes(total)}; a message can carry up to ${formatBytes(MAX_TOTAL_BYTES)}.`;
  return null;
}

/**
 * The server's check of one uploaded file: the name rules, then the bytes.
 * Returns the type to store, or the reason it was refused.
 */
export function verifyFile(name: string, type: string, data: Uint8Array): { mediaType: string } | { error: string } {
  const found = kindFromName(name, type);
  if (!found) return { error: `${cleanName(name)} isn't an image, PDF or text file.` };
  if (found.kind === "text") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.includes("\u0000")) throw new Error("binary");
    } catch {
      return { error: `${cleanName(name)} isn't readable text.` };
    }
    return { mediaType: found.mediaType };
  }
  const sniffed = sniffMediaType(data);
  if (!sniffed || kindOf(sniffed) !== found.kind) {
    return { error: `${cleanName(name)} doesn't look like ${found.kind === "pdf" ? "a PDF" : "a PNG, JPEG, GIF or WebP image"}.` };
  }
  return { mediaType: sniffed };
}

/** Attachments a bot reads with a reply, per turn. */
export const MAX_CONTEXT_ATTACHMENTS = 4;

/**
 * Which attachments go with a reply: the message's own first, then the
 * newest from earlier lines the bot is reading, up to the cap.
 */
export function contextAttachments(
  message: { id: string; attachments?: ChatAttachment[] },
  transcript: readonly { id: string; attachments?: ChatAttachment[] }[],
  limit = MAX_CONTEXT_ATTACHMENTS,
): ChatAttachment[] {
  const picked: ChatAttachment[] = [...(message.attachments ?? [])].slice(0, limit);
  for (const line of [...transcript].reverse()) {
    if (line.id === message.id) continue;
    for (const attachment of [...(line.attachments ?? [])].reverse()) {
      if (picked.length >= limit) return picked;
      if (!picked.some((item) => item.id === attachment.id)) picked.push(attachment);
    }
  }
  return picked;
}
