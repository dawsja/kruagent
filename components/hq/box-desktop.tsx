"use client";

import type RFB from "@novnc/novnc";
import type { RawChannel } from "@novnc/novnc";
import { Maximize2, Minimize2, MonitorOff, Power, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { copyToClipboard, isPasteChord } from "@/components/hq/clipboard";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A toolbar icon button whose purpose shows on hover and to screen readers.
 * The tooltip is portaled into `container` (the desktop frame) so it stays
 * above the modal and visible when the frame is full screen.
 */
function IconButton({
  label,
  onClick,
  container,
  children,
}: {
  label: string;
  onClick: () => void;
  container: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" container={container}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The box desktop: a GNOME session in the box, shown with noVNC and fully
 * controllable (mouse, keyboard, clipboard both ways). Like the terminal,
 * nothing here talks to the box directly: the VNC server's bytes arrive as
 * server-sent events through Kru and the client's go back as small POSTs.
 * Hiding the panel leaves the desktop running; Stop desktop ends it.
 *
 * Clipboard: TigerVNC mirrors the desktop's X selections into the VNC
 * clipboard and back, so text copied in the desktop reaches this browser
 * as a `clipboard` event, and text sent with `clipboardPasteFrom` becomes
 * the desktop's clipboard. The browser side is the hard part: noVNC
 * swallows every keystroke, so a paste chord is intercepted here first, its
 * paste event read, and the key replayed once the desktop has the text.
 * None of it needs a button or a permission: the clipboard is never read
 * outright (browsers answer that with a prompt or a floating Paste button),
 * only taken from the paste event a chord raises. A browser that wants a
 * gesture for the copy gets the next click in the desktop.
 */
type Status = "starting" | "connecting" | "live" | "ended" | "error";

const DEFAULT_SIZE = { width: 1280, height: 800 };

/** X keysyms for the keys a paste chord ends in, replayed after the paste. */
const PASTE_KEYSYMS: Record<string, number> = { KeyV: 0x76, Insert: 0xff63 };
/** How long to wait for the paste event the chord should raise before replaying anyway. */
const PASTE_EVENT_WAIT_MS = 250;
/** How long a clipboard notice stays in the toolbar. */
const NOTICE_MS = 2_500;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * What noVNC needs from a WebSocket, backed by one desktop connection:
 * server bytes come from its event stream, client bytes are queued and sent
 * in order, coalesced while a request is in flight. A VNC connection is one
 * stateful conversation, so any break in the stream ends it; there is no
 * reconnecting to the same connection.
 */
class SseChannel implements RawChannel {
  binaryType = "arraybuffer";
  protocol = "";
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private source: EventSource | null = null;
  private queue: Uint8Array[] = [];
  private sending = false;

  constructor(private readonly id: string) {}

  start() {
    const source = new EventSource(`/api/box/desktop/connections/${this.id}/stream`);
    this.source = source;
    source.onopen = () => {
      if (this.readyState !== "connecting") return;
      this.readyState = "open";
      this.onopen?.({});
    };
    source.onmessage = (event) => {
      const bytes = fromBase64(event.data as string);
      this.onmessage?.({ data: bytes.buffer as ArrayBuffer });
    };
    // EventSource would reconnect on its own, but the connection behind the
    // stream is gone once it drops, so a break is the end.
    source.onerror = () => this.end(false);
  }

  send(data: Uint8Array) {
    if (this.readyState !== "open") return;
    // noVNC hands over a view into a buffer it reuses; copy before queueing.
    this.queue.push(data.slice());
    void this.flush();
  }

  private async flush() {
    if (this.sending || this.queue.length === 0 || this.readyState !== "open") return;
    this.sending = true;
    const batch = this.queue.splice(0);
    const size = batch.reduce((total, part) => total + part.length, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const part of batch) {
      merged.set(part, offset);
      offset += part.length;
    }
    try {
      const res = await fetch(`/api/box/desktop/connections/${this.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: toBase64(merged) }),
      });
      if (!res.ok) throw new Error(`input rejected (${res.status})`);
    } catch (error) {
      this.sending = false;
      this.onerror?.(error);
      this.end(false);
      return;
    }
    this.sending = false;
    void this.flush();
  }

  close() {
    if (this.readyState === "closed" || this.readyState === "closing") return;
    this.readyState = "closing";
    void fetch(`/api/box/desktop/connections/${this.id}`, { method: "DELETE" }).catch(() => undefined);
    this.end(true);
  }

  private end(clean: boolean) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.source?.close();
    this.source = null;
    this.queue = [];
    // Like a WebSocket, close is reported after the caller returns; noVNC
    // arms its disconnect timer only after close() and clears it on this.
    setTimeout(() => this.onclose?.({ clean }), 0);
  }
}

export function BoxDesktop({ onClose }: { onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  // What was last sent to the desktop, so a focus sync doesn't resend it.
  const lastSent = useRef<string | null>(null);
  // Text copied in the desktop that the browser wouldn't take without a
  // gesture; the next click or key in the desktop is one, and retries.
  const pendingCopy = useRef<string | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  /** Text copied in the desktop: onto this machine's clipboard, if the browser allows. */
  const onRemoteClipboard = useCallback(
    (text: string) => {
      if (!text) return;
      void copyToClipboard(text).then((done) => {
        pendingCopy.current = done ? null : text;
        showNotice(done ? "Copied from the desktop" : "Copied in the desktop; click in it once to take it");
      });
    },
    [showNotice],
  );


  // Closing the panel disconnects the viewer (see the effect's cleanup); this
  // also stops the desktop itself and everything running on it.
  const stopDesktop = useCallback(async () => {
    await fetch("/api/box/desktop", { method: "DELETE" }).catch(() => undefined);
    onClose();
  }, [onClose]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let disposed = false;
    let channel: SseChannel | null = null;
    let client: RFB | null = null;
    // noVNC logs an error when a finished client is disconnected again.
    let finished = false;
    setStatus("starting");
    setMessage(null);

    void (async () => {
      // The desktop is sized to this panel; noVNC asks the server to follow
      // later resizes (GNOME on TigerVNC honours them).
      const width = Math.max(Math.round(node.clientWidth) || DEFAULT_SIZE.width, 640);
      const height = Math.max(Math.round(node.clientHeight) || DEFAULT_SIZE.height, 480);
      const res = await fetch("/api/box/desktop/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width, height }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        connection?: { id: string };
        error?: string;
      };
      if (disposed) return;
      if (!res.ok || !data.connection) {
        setStatus("error");
        setMessage(data.error ?? "Could not open the box desktop.");
        return;
      }
      setStatus("connecting");

      // noVNC touches the DOM at import time, so it's loaded in the browser only.
      const { default: RFBClient } = await import("@novnc/novnc");
      if (disposed) return;
      channel = new SseChannel(data.connection.id);
      client = new RFBClient(node, channel, { shared: true });
      client.scaleViewport = true;
      client.resizeSession = true;
      client.showDotCursor = true;
      client.background = "#0e1116";
      client.qualityLevel = 6;
      client.compressionLevel = 2;
      client.addEventListener("connect", () => {
        setStatus("live");
        client?.focus();
      });
      client.addEventListener("disconnect", (event) => {
        finished = true;
        if (disposed) return;
        setStatus((current) => (current === "error" ? current : "ended"));
        if (!event.detail.clean) setMessage("The desktop connection dropped.");
      });
      client.addEventListener("securityfailure", (event) => {
        setStatus("error");
        setMessage(event.detail.reason ?? "The desktop refused the connection.");
      });
      client.addEventListener("clipboard", (event) => onRemoteClipboard(event.detail.text));
      rfb.current = client;
      channel.start();
    })();

    return () => {
      disposed = true;
      rfb.current = null;
      // Disconnecting closes the channel, which tells the box to drop the connection.
      if (client && !finished) client.disconnect();
      else channel?.close();
    };
  }, [attempt, onRemoteClipboard]);

  // Pasting into the desktop. noVNC stops every keydown it sees, and a
  // stopped Ctrl+V never becomes a paste event, so paste chords are caught
  // on the way down (capture phase, before noVNC's own listener on the
  // canvas) and only kept from reaching it. The browser then raises the
  // paste event, whose text goes to the desktop as its clipboard, and the
  // key is replayed so the focused app pastes it. The modifiers were never
  // intercepted, so they're still held on the desktop; only the final key
  // is sent. If no paste event comes (an empty clipboard, a browser that
  // won't raise one) the key is replayed anyway after a short wait.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const swallowed = new Set<string>();
    let pending: { code: string; timer: number } | null = null;

    const replay = (code: string) => {
      const client = rfb.current;
      const keysym = PASTE_KEYSYMS[code];
      if (client && keysym) client.sendKey(keysym, code);
    };
    const settle = () => {
      if (!pending) return;
      window.clearTimeout(pending.timer);
      const { code } = pending;
      pending = null;
      return code;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!rfb.current || !isPasteChord(event) || !(event.code in PASTE_KEYSYMS)) return;
      event.stopPropagation();
      swallowed.add(event.code);
      const code = event.code;
      if (pending) window.clearTimeout(pending.timer);
      pending = {
        code,
        timer: window.setTimeout(() => {
          pending = null;
          replay(code);
        }, PASTE_EVENT_WAIT_MS),
      };
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!swallowed.delete(event.code)) return;
      event.stopPropagation();
    };
    const onPaste = (event: ClipboardEvent) => {
      const client = rfb.current;
      if (!client) return;
      const code = settle();
      const active = document.activeElement;
      // A paste meant for the desktop: raised by an intercepted chord, or
      // by a browser menu while the desktop has focus.
      if (!code && active && active !== document.body && !node.contains(active)) return;
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text && text !== lastSent.current) {
        lastSent.current = text;
        client.clipboardPasteFrom(text);
      }
      if (code) replay(code);
    };

    node.addEventListener("keydown", onKeyDown, true);
    node.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("paste", onPaste);
    return () => {
      settle();
      node.removeEventListener("keydown", onKeyDown, true);
      node.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  // A gesture in the desktop retries a copy the browser refused earlier.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const retry = () => {
      const text = pendingCopy.current;
      if (!text) return;
      pendingCopy.current = null;
      void copyToClipboard(text).then((done) => {
        if (done) showNotice("Copied from the desktop");
        else pendingCopy.current = text;
      });
    };
    node.addEventListener("pointerdown", retry, true);
    node.addEventListener("keydown", retry, true);
    return () => {
      node.removeEventListener("pointerdown", retry, true);
      node.removeEventListener("keydown", retry, true);
    };
  }, [showNotice]);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const onChange = () => setFullscreen(document.fullscreenElement === node);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggleFullscreen() {
    const node = frame.current;
    if (!node) return;
    if (document.fullscreenElement === node) void document.exitFullscreen();
    else void node.requestFullscreen?.();
  }

  const label =
    status === "live"
      ? "connected"
      : status === "starting"
        ? "starting desktop"
        : status === "ended"
          ? "disconnected"
          : status;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        aria-label="Hide desktop"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        ref={frame}
        className="relative flex h-[min(88vh,56rem)] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0e1116] shadow-subtle-3"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-[13px] font-medium text-white/90">Box · Desktop</span>
            <span
              className={
                "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
                (status === "live"
                  ? "bg-mint/20 text-mint"
                  : status === "error"
                    ? "bg-ember/20 text-ember"
                    : "bg-white/10 text-white/60")
              }
            >
              {label}
            </span>
            {notice ? (
              <span className="truncate text-[12px] text-white/70">{notice}</span>
            ) : message ? (
              <span className="truncate text-[12px] text-white/50">{message}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {status === "ended" || status === "error" ? (
              <button
                type="button"
                onClick={() => setAttempt((current) => current + 1)}
                className="rounded-full px-2.5 py-1 text-[12px] text-white/60 hover:bg-white/10 hover:text-white"
              >
                Reconnect
              </button>
            ) : null}
            {status === "live" ? (
              <IconButton container={frame} label="Send Ctrl+Alt+Del" onClick={() => rfb.current?.sendCtrlAltDel()}>
                <Power className="size-4" />
              </IconButton>
            ) : null}
            <IconButton container={frame} label="Stop the desktop" onClick={() => void stopDesktop()}>
              <MonitorOff className="size-4" />
            </IconButton>
            <IconButton container={frame} label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </IconButton>
            <IconButton container={frame} label="Hide (the desktop keeps running)" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
        </div>
        <div ref={host} className="min-h-0 flex-1 overflow-hidden [&>div]:h-full" />
      </div>
    </div>
  );
}
