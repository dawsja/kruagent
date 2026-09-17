import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimPendingMessages,
  clearChatMessages,
  insertChatMessage,
  listChatMessages,
  markChatAnswered,
  recentChatMessages,
} from "../lib/hq/data.ts";
import { subscribe, type LiveEvent } from "../lib/hq/events.ts";
import type { ChatMessage } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

function line(id: string, at: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, author: "you", kind: "message", body: id, mentions: [], cardId: null, replyTo: null, depth: 0, createdAt: at, ...patch };
}

test("messages list in order and page by cursor", () => {
  const temp = useTempDataDir();
  try {
    insertChatMessage(line("m1", "2026-01-01T00:00:01.000Z"));
    insertChatMessage(line("m3", "2026-01-01T00:00:03.000Z", { author: "pip", kind: "event" }));
    insertChatMessage(line("m2", "2026-01-01T00:00:02.000Z", { mentions: ["pip"] }));
    assert.deepEqual(listChatMessages().map((m) => m.id), ["m1", "m2", "m3"]);
    assert.deepEqual(listChatMessages({ after: "2026-01-01T00:00:01.000Z" }).map((m) => m.id), ["m2", "m3"]);
    assert.deepEqual(recentChatMessages(2).map((m) => m.id), ["m2", "m3"]);
    assert.deepEqual(listChatMessages().find((m) => m.id === "m2")?.mentions, ["pip"]);
  } finally {
    temp.cleanup();
  }
});

test("pending messages are claimed once and answered", () => {
  const temp = useTempDataDir();
  try {
    insertChatMessage(line("m1", "2026-01-01T00:00:01.000Z"), { pending: true });
    insertChatMessage(line("e1", "2026-01-01T00:00:02.000Z", { author: "momo", kind: "event" }));
    insertChatMessage(line("m2", "2026-01-01T00:00:03.000Z"), { pending: true });
    const first = claimPendingMessages("a", 1);
    assert.deepEqual(first.map((m) => m.id), ["m1"]);
    assert.deepEqual(claimPendingMessages("b", 5).map((m) => m.id), ["m2"], "m1 is owned, e1 was never pending");
    assert.deepEqual(claimPendingMessages("c", 5), []);
    markChatAnswered("m1");
    markChatAnswered("m2");
    assert.deepEqual(claimPendingMessages("d", 5), []);
  } finally {
    temp.cleanup();
  }
});

test("clearing the room deletes every line and says so", () => {
  const temp = useTempDataDir();
  const events: LiveEvent[] = [];
  const stop = subscribe((event) => events.push(event));
  try {
    insertChatMessage(line("m1", "2026-01-01T00:00:01.000Z"), { pending: true });
    insertChatMessage(line("e1", "2026-01-01T00:00:02.000Z", { author: "pip", kind: "event" }));
    events.length = 0;
    assert.equal(clearChatMessages(), 2);
    assert.deepEqual(listChatMessages(), []);
    assert.deepEqual(claimPendingMessages("a", 5), [], "a cleared question isn't answered");
    assert.deepEqual(events, [{ topic: "chat", cleared: true }]);
    assert.equal(clearChatMessages(), 0);
  } finally {
    stop();
    temp.cleanup();
  }
});
