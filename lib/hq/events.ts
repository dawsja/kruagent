/*
 * What changed, as it happens: the data layer announces each write here and
 * the browser hears it over /api/events, so the board, the Team room and
 * the unread dot fetch when something moved instead of on a timer. Kru is
 * one process with one database, so an in-memory list of listeners is the
 * whole bus. The events carry no data, only what to fetch again.
 */

export type LiveEvent =
  /** Cards, runs, the crew's jobs, pull request feedback or board settings changed. */
  | { topic: "board" }
  /** One run's log or result changed; the open card fetches it again. */
  | { topic: "run"; runId: string }
  /** A line was added to the Team room, or `cleared`: every line was deleted. */
  | { topic: "chat"; cleared?: boolean };

type Listener = (event: LiveEvent) => void;

// On globalThis: in development, routes and the dispatcher can load their
// own copies of this module, and they must all share one bus.
const holder = globalThis as typeof globalThis & { __kruLiveListeners?: Set<Listener> };

function listeners(): Set<Listener> {
  return (holder.__kruLiveListeners ??= new Set());
}

/** Hears every event until the returned function is called. */
export function subscribe(listener: Listener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

/** Tells every listener. A listener that throws is dropped; nobody else misses out. */
export function emit(event: LiveEvent) {
  for (const listener of [...listeners()]) {
    try {
      listener(event);
    } catch {
      listeners().delete(listener);
    }
  }
}

export function boardChanged() {
  emit({ topic: "board" });
}

export function runChanged(runId: string) {
  emit({ topic: "run", runId });
  emit({ topic: "board" });
}

export function chatChanged() {
  emit({ topic: "chat" });
}

export function chatCleared() {
  emit({ topic: "chat", cleared: true });
}

/** How many browsers are listening; for tests and the health of the stream. */
export function listenerCount(): number {
  return listeners().size;
}
