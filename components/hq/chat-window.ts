"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/*
 * The Team room in its own browser window, and how it talks to the board.
 * Both windows poll the same room; this channel only says whether the window
 * is open and hands over what the board has to do (open a card, reload).
 */

export const CHAT_WINDOW_PATH = "/app/chat";
const WINDOW_NAME = "kru-team-chat";
const CHANNEL = "kru.team-chat";
const DRAFT_KEY = "kru.chatDraft";

export type ChatWindowEvent =
  /** The window is open (sent on load and in answer to a ping). */
  | { type: "popped" }
  /** The user docked the window; the room goes back to the side panel. */
  | { type: "docked" }
  /** The window went away (its close button, a reload); nothing reopens. */
  | { type: "closed" }
  /** The board asks whether a window is open. */
  | { type: "ping" }
  | { type: "open-card"; cardId: string }
  /** New lines arrived; the crew may have changed the board. */
  | { type: "activity" };

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
}

// Kept open for the page's life: a channel opened while the window is
// closing can drop the message that says so.
let sender: BroadcastChannel | null = null;

export function postChatEvent(event: ChatWindowEvent) {
  sender ??= channel();
  sender?.postMessage(event);
}

/** Listens on the channel for as long as the component is mounted. */
export function useChatEvents(onEvent: (event: ChatWindowEvent) => void) {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    const bus = channel();
    if (!bus) return;
    bus.onmessage = (message: MessageEvent<ChatWindowEvent>) => handler.current(message.data);
    return () => bus.close();
  }, []);
}

/**
 * Opens the room in a separate window, or brings an open one forward. Null
 * when the browser blocked it.
 */
export function openChatWindow(): Window | null {
  // Wide enough for long lines, tall enough to read a few turns back. The
  // 300px this used to be left room for only two or three lines.
  const width = Math.min(900, window.screen.availWidth);
  const height = Math.min(640, window.screen.availHeight);
  // Kept on-screen: a window whose requested top/left would run past the
  // screen's edge gets shrunk by the OS to fit rather than repositioned, so
  // clamp here instead of trusting it to.
  const left = Math.min(
    Math.max(0, window.screenX + window.outerWidth - width - 24),
    Math.max(0, window.screen.availWidth - width),
  );
  const top = Math.min(
    Math.max(0, window.screenY + 80),
    Math.max(0, window.screen.availHeight - height),
  );
  const opened = window.open(
    CHAT_WINDOW_PATH,
    WINDOW_NAME,
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
  // A second window.open() on a name that's already open just focuses it and
  // ignores the features string, so a window left small by a previous drag
  // (or opened before a size change) would otherwise stay that size.
  opened?.resizeTo(width, height);
  opened?.moveTo(left, top);
  opened?.focus();
  return opened;
}

/** Focuses the open window without reloading it. */
export function focusChatWindow() {
  // An empty URL finds the named window without navigating it.
  const existing = window.open("", WINDOW_NAME);
  if (existing && existing.location.href === "about:blank") {
    // Nothing was open after all; don't leave a blank window behind.
    existing.close();
    return false;
  }
  existing?.focus();
  return Boolean(existing);
}

const draftListeners = new Set<() => void>();

function readDraft() {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function subscribeDraft(listener: () => void) {
  draftListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === DRAFT_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    draftListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function writeDraft(value: string) {
  try {
    if (value) window.localStorage.setItem(DRAFT_KEY, value);
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Private mode: the draft stays in this window only.
    fallbackDraft = value;
  }
  draftListeners.forEach((listener) => listener());
}

let fallbackDraft = "";

/**
 * The unsent message, shared by every window of the app: type in the side
 * panel, pop out, and it's still there. Storage events carry it across.
 */
export function useSharedDraft(): [string, (next: string | ((current: string) => string)) => void] {
  const draft = useSyncExternalStore(subscribeDraft, () => readDraft() || fallbackDraft, () => "");
  const set = (next: string | ((current: string) => string)) =>
    writeDraft(typeof next === "function" ? next(readDraft() || fallbackDraft) : next);
  return [draft, set];
}
