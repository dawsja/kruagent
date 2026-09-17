"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LiveEvent } from "@/lib/hq/events";

/*
 * One connection to /api/events for the whole page, shared by everything
 * that wants to know when the board or the Team room changed. `open` is
 * sent each time the stream (re)connects: whatever was missed while it was
 * down, the listener fetches again. While the stream is down the callers
 * fall back to polling at their old pace, so nothing depends on it.
 */

export type LiveMessage = LiveEvent | { topic: "open" };

type Listener = (message: LiveMessage) => void;

const listeners = new Set<Listener>();
const connectionListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const listener of connectionListeners) listener();
}

function dispatch(message: LiveMessage) {
  for (const listener of [...listeners]) listener(message);
}

function connect() {
  if (source || typeof EventSource === "undefined") return;
  const stream = new EventSource("/api/events");
  source = stream;
  stream.onopen = () => {
    setConnected(true);
    dispatch({ topic: "open" });
  };
  stream.onmessage = (event: MessageEvent<string>) => {
    try {
      dispatch(JSON.parse(event.data) as LiveEvent);
    } catch {
      // Not ours.
    }
  };
  stream.onerror = () => {
    setConnected(false);
    // A refused stream (signed out, a proxy that won't stream) is closed for
    // good; try again later rather than never.
    if (stream.readyState === EventSource.CLOSED) {
      stream.close();
      if (source === stream) source = null;
      window.setTimeout(() => {
        if (listeners.size > 0) connect();
      }, 30_000);
    }
  };
}

function disconnect() {
  source?.close();
  source = null;
  setConnected(false);
}

/**
 * Calls `onMessage` for every event while mounted, and returns whether the
 * stream is up right now (so the caller can poll slowly or quickly).
 */
export function useLiveEvents(onMessage: Listener): boolean {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const listener: Listener = (message) => handler.current(message);
    listeners.add(listener);
    connect();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) disconnect();
    };
  }, []);

  return useSyncExternalStore(
    (notify) => {
      connectionListeners.add(notify);
      return () => connectionListeners.delete(notify);
    },
    () => connected,
    () => false,
  );
}

/** How often to poll anyway: rarely while events arrive, as before when they don't. */
export function pollInterval(live: boolean, fallbackMs: number, safetyMs = 30_000) {
  return live ? Math.max(safetyMs, fallbackMs) : fallbackMs;
}
