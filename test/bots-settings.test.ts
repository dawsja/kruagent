import assert from "node:assert/strict";
import { test } from "node:test";
import { getBotsEnabled, getOnboarding, saveOnboarding, setBotsEnabled } from "../lib/hq/data.ts";
import { useTempDataDir } from "./helpers.ts";

test("bots are off until switched on, and survive an onboarding save", () => {
  const temp = useTempDataDir();
  try {
    assert.equal(getBotsEnabled(), false);
    setBotsEnabled(true);
    assert.equal(getBotsEnabled(), true);
    saveOnboarding({ complete: true, model: null, repo: null });
    assert.equal(getBotsEnabled(), true, "onboarding must not clobber the switch");
    assert.equal(getOnboarding()?.complete, true);
    setBotsEnabled(false);
    assert.equal(getBotsEnabled(), false);
  } finally {
    temp.cleanup();
  }
});
