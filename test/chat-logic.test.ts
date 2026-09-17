import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHAIN, RateLimiter, canReply, parseMentions, shouldPend, targetsFor, transcriptLine } from "../lib/hq/bots/chat-logic.ts";
import type { ChatMessage } from "../lib/hq/types";

test("mentions are found once each, case-insensitively, and not inside emails", () => {
  assert.deepEqual(parseMentions("@pip make a card, @Momo and @pip again"), ["pip", "momo"]);
  assert.deepEqual(parseMentions("mail me at a@pip.com"), []);
  assert.deepEqual(parseMentions("(@lulu) @kiko: @bibi."), ["lulu", "kiko", "bibi"]);
  assert.deepEqual(parseMentions("@pippa @momosan @nobody"), []);
  assert.deepEqual(parseMentions("@@pip"), []);
});

test("targets: you reach Pip by default, bots never address themselves, events reach nobody", () => {
  assert.deepEqual(targetsFor({ author: "you", kind: "message", mentions: [] }), ["pip"]);
  assert.deepEqual(targetsFor({ author: "you", kind: "message", mentions: ["kiko"] }), ["kiko"]);
  assert.deepEqual(targetsFor({ author: "momo", kind: "message", mentions: ["momo", "kiko"] }), ["kiko"]);
  assert.deepEqual(targetsFor({ author: "momo", kind: "message", mentions: [] }), []);
  assert.deepEqual(targetsFor({ author: "momo", kind: "event", mentions: ["kiko"] }), []);
});

test("bot chains stop at the depth cap", () => {
  assert.equal(canReply({ author: "you", depth: 0 }), true);
  assert.equal(canReply({ author: "momo", depth: MAX_CHAIN - 1 }), true);
  assert.equal(canReply({ author: "momo", depth: MAX_CHAIN }), false);
  assert.equal(shouldPend({ author: "kiko", kind: "message", mentions: ["lulu"], depth: 2 }), true);
  assert.equal(shouldPend({ author: "kiko", kind: "message", mentions: ["lulu"], depth: MAX_CHAIN }), false);
  assert.equal(shouldPend({ author: "kiko", kind: "event", mentions: ["lulu"], depth: 0 }), false);
  assert.equal(shouldPend({ author: "kiko", kind: "message", mentions: [], depth: 1 }), false);
});

test("the rate limiter is a sliding window", () => {
  const limiter = new RateLimiter(2, 1000);
  assert.equal(limiter.allow(0), true);
  assert.equal(limiter.allow(10), true);
  assert.equal(limiter.allow(20), false);
  assert.equal(limiter.allow(1001), true);
  assert.equal(limiter.allow(1005), false);
});

test("transcript lines name the speaker and mark events", () => {
  const base: ChatMessage = { id: "m", author: "you", kind: "message", body: "hi", mentions: [], cardId: null, replyTo: null, depth: 0, createdAt: "" };
  const name = (id: string) => (id === "momo" ? "Momo" : id);
  assert.equal(transcriptLine(base, name), "you: hi");
  assert.equal(transcriptLine({ ...base, author: "momo", kind: "event", body: "Picking up" }, name), "(Momo, event) Picking up");
});
