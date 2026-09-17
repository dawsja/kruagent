import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkFiles,
  cleanName,
  contextAttachments,
  kindFromName,
  MAX_ATTACHMENTS,
  sniffMediaType,
  verifyFile,
} from "../lib/hq/bots/attachments.ts";
import { transcriptLine } from "../lib/hq/bots/chat-logic.ts";
import { clearChatMessages, getChatAttachment, insertChatMessage, listChatMessages } from "../lib/hq/data.ts";
import type { ChatMessage } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%...");

test("attachments: accepted kinds come from type or extension", () => {
  assert.deepEqual(kindFromName("shot.png", "image/png"), { kind: "image", mediaType: "image/png" });
  assert.deepEqual(kindFromName("shot.JPG", ""), { kind: "image", mediaType: "image/jpeg" });
  assert.deepEqual(kindFromName("spec.pdf", "application/octet-stream"), { kind: "pdf", mediaType: "application/pdf" });
  assert.deepEqual(kindFromName("notes.md", ""), { kind: "text", mediaType: "text/markdown" });
  assert.equal(kindFromName("app.exe", "application/octet-stream"), null);
  assert.equal(kindFromName("vector.svg", "image/svg+xml"), null);
});

test("attachments: count, size and type are checked before upload", () => {
  const png = { name: "a.png", type: "image/png", size: 1000 };
  assert.equal(checkFiles([png]), null);
  assert.match(checkFiles(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => png)) ?? "", /at most/);
  assert.match(checkFiles([{ ...png, size: 6 * 1024 * 1024 }]) ?? "", /images can be up to 5 MB/);
  assert.match(checkFiles([{ ...png, size: 0 }]) ?? "", /empty/);
  assert.match(checkFiles([{ name: "x.zip", type: "application/zip", size: 10 }]) ?? "", /isn't an image, PDF or text/);
  const pdf = { name: "b.pdf", type: "application/pdf", size: 5 * 1024 * 1024 };
  assert.match(checkFiles([pdf, pdf]) ?? "", /a message can carry up to 9 MB/);
});

test("attachments: the server trusts the bytes, not the claimed type", () => {
  assert.equal(sniffMediaType(PNG), "image/png");
  assert.equal(sniffMediaType(PDF), "application/pdf");
  assert.deepEqual(verifyFile("a.png", "image/png", PNG), { mediaType: "image/png" });
  // A PNG named .jpg is stored as what it is.
  assert.deepEqual(verifyFile("a.jpg", "image/jpeg", PNG), { mediaType: "image/png" });
  assert.ok("error" in verifyFile("a.png", "image/png", PDF));
  assert.ok("error" in verifyFile("a.pdf", "application/pdf", new TextEncoder().encode("<html>")));
  assert.deepEqual(verifyFile("n.txt", "text/plain", new TextEncoder().encode("hello")), { mediaType: "text/plain" });
  assert.ok("error" in verifyFile("n.txt", "text/plain", new Uint8Array([0xff, 0xfe, 0x00])));
  assert.equal(cleanName("C:\\Users\\me\\bad\"name.png"), "badname.png");
  assert.equal(cleanName("../"), "attachment");
});

test("attachments: a reply reads the message's files first, then the newest earlier ones", () => {
  const file = (id: string) => ({ id, name: `${id}.png`, mediaType: "image/png", size: 1 });
  const lines = [
    { id: "m1", attachments: [file("a"), file("b")] },
    { id: "m2" },
    { id: "m3", attachments: [file("c")] },
    { id: "m4", attachments: [file("d")] },
  ];
  assert.deepEqual(contextAttachments(lines[3], lines, 3).map((f) => f.id), ["d", "c", "b"]);
  assert.deepEqual(contextAttachments({ id: "m9" }, [], 3), []);
});

test("attachments: stored with the message, listed without bytes, deleted with the room", () => {
  const temp = useTempDataDir();
  try {
    const message: ChatMessage = {
      id: "m1",
      author: "you",
      kind: "message",
      body: "look at this",
      mentions: [],
      cardId: null,
      replyTo: null,
      depth: 0,
      createdAt: "2026-01-01T00:00:01.000Z",
      attachments: [{ id: "f1", name: "shot.png", mediaType: "image/png", size: PNG.byteLength }],
    };
    insertChatMessage(message, {
      pending: true,
      files: [
        { id: "f1", name: "shot.png", mediaType: "image/png", data: PNG },
        { id: "f2", name: "spec.pdf", mediaType: "application/pdf", data: PDF },
      ],
    });
    insertChatMessage({ ...message, id: "m2", createdAt: "2026-01-01T00:00:02.000Z", attachments: undefined });
    const [first, second] = listChatMessages();
    assert.deepEqual(first.attachments?.map((f) => [f.id, f.name, f.size]), [
      ["f1", "shot.png", PNG.byteLength],
      ["f2", "spec.pdf", PDF.byteLength],
    ]);
    assert.equal(second.attachments, undefined);
    assert.match(transcriptLine(first, (id) => id), /^you: look at this \[attached: shot.png, spec.pdf\]$/);
    const stored = getChatAttachment("f2");
    assert.equal(stored?.messageId, "m1");
    assert.deepEqual(new Uint8Array(stored!.data), PDF);
    clearChatMessages();
    assert.equal(getChatAttachment("f1"), null);
  } finally {
    temp.cleanup();
  }
});
