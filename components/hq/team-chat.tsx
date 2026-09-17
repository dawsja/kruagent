"use client";

import { FileText, PanelRight, Paperclip, PictureInPicture2, SendHorizonal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { BotAvatar } from "@/components/hq/bot-avatar";
import { postChatEvent, useChatEvents, useSharedDraft } from "@/components/hq/chat-window";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import {
  filterMentions,
  insertMention,
  mentionTokenAt,
  pickerKey,
  pickerOpen,
  type MentionOption,
} from "@/components/hq/mention-picker-logic";
import { KruBot } from "@/components/hq/kru-bot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACCEPT, checkFiles, formatBytes, kindOf, MAX_ATTACHMENTS } from "@/lib/hq/bots/attachments";
import { MENTION } from "@/lib/hq/bots/chat-logic";
import { BOTS, getBot, type Bot } from "@/lib/hq/bots/registry";
import { parseInline, type Inline } from "@/lib/hq/markdown";
import { isBotId, type ChatAttachment, type ChatMessage } from "@/lib/hq/types";
import { botInk } from "@/lib/theme/bot-color";
import { cn } from "@/lib/utils";

/*
 * The Team room: one thread where you and the crew talk. Polled while open,
 * like the board. Events are the crew's progress lines; a line about a card
 * opens that card. It docks to the side, or pops out into its own browser
 * window (see chat-window.ts); either way it is the same room.
 */

/** How often the room is polled while /api/events is down. */
const POLL_MS = 2_000;
/** How often the "thinking…" clock ticks. */
const CLOCK_MS = 5_000;
/** How long after your message a reply is still expected. */
const THINKING_MS = 150_000;
/** Room the resize handle leaves between a widened panel and the left edge. */
const RESIZE_MARGIN = 48;
const RESIZE_STEP = 32;

/**
 * The room's lines and your message to it, polled while `active`. Each
 * window runs its own; the draft is shared between them.
 */
function useRoom({
  active,
  enabled,
  onActivity,
  textarea,
}: {
  active: boolean;
  enabled: boolean;
  onActivity?: () => void;
  /** The message box, focused again after sending or mentioning. */
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useSharedDraft();
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Files waiting in the composer, with a preview URL for images; each
  // window keeps its own.
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Advanced by the poll, so "thinking…" fades without a clock in render.
  const [now, setNow] = useState(0);
  const activity = useRef(onActivity);
  useEffect(() => {
    activity.current = onActivity;
  }, [onActivity]);

  const append = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((current) => {
      const seen = new Set(current.map((item) => item.id));
      const fresh = incoming.filter((item) => !seen.has(item.id));
      return fresh.length ? [...current, ...fresh] : current;
    });
  }, []);

  const load = useCallback(
    (after: string | null) =>
      fetch(`/api/chat${after ? `?after=${encodeURIComponent(after)}` : ""}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { messages?: ChatMessage[] } | null) => {
          if (data?.messages) append(data.messages);
          // A reply like "Created card …" lands with the card already saved,
          // so the board catches up now rather than on its next poll.
          if (after && data?.messages?.length) activity.current?.();
          setLoaded(true);
          setNow(Date.now());
        })
        .catch(() => undefined),
    [append],
  );

  // Everything once on open, then only what's new: at once when
  // /api/events says the room changed, and on a slow poll as a safety net
  // (the old pace while the stream is down).
  const cursor = messages.at(-1)?.createdAt ?? null;
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  useEffect(() => {
    if (!active) return;
    void load(null);
  }, [active, load]);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const live = useLiveEvents((message) => {
    if (!activeRef.current) return;
    if (message.topic === "chat" || message.topic === "open") void load(cursorRef.current);
  });
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void load(cursorRef.current);
    }, pollInterval(live, POLL_MS));
    return () => window.clearInterval(timer);
  }, [active, live, load]);
  // The clock behind "thinking…", which fades out on its own.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  /** Adds files to the composer, or says why they can't go. */
  function attach(added: readonly File[]) {
    if (added.length === 0) return;
    const problem = checkFiles([...files.map((item) => item.file), ...added]);
    if (problem) {
      setNotice(problem);
      return;
    }
    setNotice(null);
    setFiles([
      ...files,
      ...added.map((file) => ({ file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null })),
    ]);
    textarea.current?.focus();
  }

  function detach(index: number) {
    const preview = files[index]?.preview;
    if (preview) URL.revokeObjectURL(preview);
    setFiles((current) => current.filter((_, at) => at !== index));
    textarea.current?.focus();
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && files.length === 0) || sending) return;
    setSending(true);
    setNotice(null);
    let body: BodyInit = JSON.stringify({ body: text });
    if (files.length) {
      const form = new FormData();
      form.set("body", text);
      for (const { file } of files) form.append("files", file, file.name);
      body = form;
    }
    const res = await fetch("/api/chat", {
      method: "POST",
      // A form sets its own multipart type, boundary included.
      headers: files.length ? undefined : { "Content-Type": "application/json" },
      body,
    }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as { message?: ChatMessage; notice?: string | null; error?: string } | undefined;
    setSending(false);
    if (!res?.ok || !data?.message) {
      setNotice(data?.error ?? "Could not send");
      return;
    }
    setDraft("");
    for (const { preview } of files) if (preview) URL.revokeObjectURL(preview);
    setFiles([]);
    append([data.message]);
    if (data.notice) setNotice(data.notice);
    textarea.current?.focus();
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function mention(id: string) {
    setDraft((current) => (current.includes(`@${id}`) ? current : `@${id} ${current}`.trimEnd() + " "));
    textarea.current?.focus();
  }

  const last = messages.at(-1);
  const thinking =
    enabled &&
    last?.author === "you" &&
    now - new Date(last.createdAt).getTime() < THINKING_MS;

  return {
    messages,
    loaded,
    last,
    thinking,
    draft,
    setDraft,
    files,
    attach,
    detach,
    sending,
    notice,
    setNotice,
    send,
    onKey,
    mention,
  };
}

type Room = ReturnType<typeof useRoom>;

type PendingAttachment = { file: File; preview: string | null };

export function TeamChat({
  open,
  onOpenChange,
  popped,
  onPopOut,
  enabled,
  onActivity,
  onOpenCard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The room is open in its own window, so the side panel stays hidden. */
  popped: boolean;
  /** Opens the room in its own window; false when the browser blocked it. */
  onPopOut: () => boolean;
  enabled: boolean;
  /** New lines arrived; the crew may have changed the board. */
  onActivity?: () => void;
  onOpenCard: (cardId: string) => void;
}) {
  const docked = open && !popped;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const room = useRoom({ active: docked, enabled, onActivity, textarea });
  // Dragged width in px; null is the sheet's own default. Reset on every
  // open, so a wider panel lasts only until it's closed.
  const [width, setWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setWidth(null);
  }

  return (
    <Sheet open={docked} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        style={width === null ? undefined : { width, maxWidth: "none" }}
        overlayClassName="top-[var(--hq-header-h,0px)]"
        className={cn(
          "w-full gap-0 bg-paper-white p-0 sm:max-w-md data-[side=right]:top-[var(--hq-header-h,0px)] data-[side=right]:h-auto data-[side=right]:bottom-0",
          resizing && "select-none",
        )}
      >
        <ResizeHandle onResize={setWidth} onResizingChange={setResizing} />
        <SheetHeader className="border-b border-fog pr-20">
          <SheetTitle className="flex items-center gap-2 text-[15px]">Team</SheetTitle>
          <SheetDescription>
            {enabled ? "You and the crew. Mention a bot to address it; Pip answers otherwise." : "The crew is off."}
          </SheetDescription>
        </SheetHeader>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Pop out the chat into its own window"
                onClick={() => {
                  if (!onPopOut()) room.setNotice("Your browser blocked the chat window. Allow pop-ups for this site to pop it out.");
                }}
                className="absolute top-3 right-12"
              />
            }
          >
            <PictureInPicture2 />
          </TooltipTrigger>
          <TooltipContent side="bottom">Pop out into its own window</TooltipContent>
        </Tooltip>

        <OffAlert enabled={enabled} />
        <Thread room={room} onOpenCard={onOpenCard} />

        <Composer room={room} textarea={textarea} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The room as a page of its own, for the popped-out browser window: the same
 * room and look as the side panel. It can sit on another monitor while the
 * board keeps working: both poll the room, and the board hears over the
 * channel when this window opens, closes, or asks it to open a card.
 */
export function TeamChatWindow() {
  const router = useRouter();
  // Null until the crew's switch is read, so "Bots are off" doesn't flash.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const check = () =>
      void fetch("/api/bots")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { enabled?: boolean } | null) => {
          if (data) setEnabled(Boolean(data.enabled));
        })
        .catch(() => undefined);
    check();
    // Settings may turn the crew on or off in the other window.
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  useChatEvents((event) => {
    if (event.type === "ping") postChatEvent({ type: "popped" });
  });
  useEffect(() => {
    postChatEvent({ type: "popped" });
    // Closing the window just closes the chat; only the dock button brings
    // it back to the side panel.
    const onHide = () => postChatEvent({ type: "closed" });
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const onActivity = useCallback(() => postChatEvent({ type: "activity" }), []);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const room = useRoom({ active: true, enabled: Boolean(enabled), onActivity, textarea });

  function openCard(cardId: string) {
    postChatEvent({ type: "open-card", cardId });
    window.opener?.focus();
  }

  function dock() {
    postChatEvent({ type: "docked" });
    // Only a window the board opened can close itself; otherwise go to the board.
    window.close();
    if (!window.closed) router.push("/app");
  }

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-paper-white">
      {/* Like a group chat: the crew's faces side by side, centered. */}
      <header className="flex items-center justify-center border-b border-fog px-14 py-3">
        <h1 className="sr-only">Team</h1>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {BOTS.map((bot) => (
            <BotAvatar key={bot.id} bot={bot} size={32} />
          ))}
        </div>
      </header>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dock the chat back into the board"
              onClick={dock}
              className="absolute top-3 right-3"
            />
          }
        >
          <PanelRight />
        </TooltipTrigger>
        <TooltipContent side="bottom">Dock back into the board</TooltipContent>
      </Tooltip>

      <OffAlert enabled={enabled !== false} />
      <Thread room={room} onOpenCard={openCard} />

      <Composer room={room} textarea={textarea} autoFocus />
    </div>
  );
}

function Thread({ room, onOpenCard }: { room: Room; onOpenCard: (cardId: string) => void }) {
  const { messages, loaded, last, thinking } = room;
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport className="px-4 py-4">
          <MessageScrollerContent className="gap-4">
            {loaded && messages.length === 0 ? (
              <Empty className="border-fog">
                <EmptyHeader>
                  <EmptyMedia>
                    <KruBot color={getBot("pip").color} size={72} expression="wink" label="Pip winking" />
                  </EmptyMedia>
                  <EmptyTitle>Say hi to the crew</EmptyTitle>
                  <EmptyDescription>
                    Ask Pip to create a card, ask Kiko to run something on the box, or just watch the
                    handoffs land here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {messages.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id}>
                <Line message={message} onOpenCard={onOpenCard} />
              </MessageScrollerItem>
            ))}
            {thinking ? (
              <MessageScrollerItem messageId="thinking">
                <Marker>
                  <MarkerIcon>
                    <BotAvatar bot={getBot(last?.mentions[0] ?? "pip")} size={16} />
                  </MarkerIcon>
                  <MarkerContent className="shimmer">
                    {getBot(last?.mentions[0] ?? "pip").name} is thinking…
                  </MarkerContent>
                </Marker>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
      <FollowLatest lastId={last?.id ?? null} thinking={Boolean(thinking)} />
    </MessageScrollerProvider>
  );
}

/**
 * Where you write to the room: the message, the files attached to it, and
 * the bots to mention. Files come from the paperclip, a paste, or a drop.
 */
function Composer({
  room,
  textarea,
  autoFocus,
}: {
  room: Room;
  textarea: RefObject<HTMLTextAreaElement | null>;
  autoFocus?: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const full = room.files.length >= MAX_ATTACHMENTS;
  const mentions = useMentionPicker(room, textarea);

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length === 0) return;
    event.preventDefault();
    room.attach(pasted);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    room.attach(Array.from(event.dataTransfer.files));
  }

  return (
    <form
      onSubmit={(event) => void room.send(event)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className="border-t border-fog p-3"
    >
      {room.notice ? <p className="mb-2 text-[12px] text-amber">{room.notice}</p> : null}
      {/* The picker hangs off the message box, so it has to be positioned against it. */}
      <div className="relative">
        {mentions.open ? (
          <MentionList
            id={mentions.listId}
            bots={mentions.matches}
            active={mentions.active}
            onHighlight={mentions.setHighlight}
            onPick={mentions.pick}
          />
        ) : null}
        <InputGroup className={cn("rounded-2xl border-fog bg-linen", dragging && "border-ash border-dashed")}>
          {room.files.length ? (
            <InputGroupAddon align="block-start" className="flex-wrap justify-start gap-1.5 pb-0">
              {room.files.map((item, index) => (
                <PendingFile key={item.preview ?? `${item.file.name}-${item.file.lastModified}-${index}`} item={item} onRemove={() => room.detach(index)} />
              ))}
            </InputGroupAddon>
          ) : null}
          <InputGroupTextarea
            ref={textarea}
            value={room.draft}
            onChange={(event) => {
              room.setDraft(event.target.value);
              mentions.onCaret(event.target);
            }}
            // The picker gets the key first: while it is open, Enter picks a
            // bot instead of sending, and the arrows move its highlight.
            onKeyDown={(event) => {
              if (!mentions.onKeyDown(event)) room.onKey(event);
            }}
            // The caret also moves without the text changing (arrows, Home, a
            // click), and leaving the @ token that way closes the picker.
            onSelect={(event) => mentions.onCaret(event.currentTarget)}
            onKeyUp={(event) => mentions.onCaret(event.currentTarget)}
            onClick={(event) => mentions.onCaret(event.currentTarget)}
            onFocus={(event) => mentions.onCaret(event.currentTarget)}
            onBlur={mentions.onBlur}
            onPaste={onPaste}
            placeholder="Message the crew… (@ to mention a bot, Enter sends, Shift+Enter for a new line)"
            rows={2}
            autoFocus={autoFocus}
            aria-label="Message"
            role="combobox"
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-expanded={mentions.open}
            aria-controls={mentions.open ? mentions.listId : undefined}
            aria-activedescendant={mentions.open ? mentionOptionId(mentions.listId, mentions.matches[mentions.active].id) : undefined}
          />
          <InputGroupAddon align="block-end" className="justify-between">
            <MentionBar room={room} />
            <div className="flex shrink-0 items-center gap-1">
              <input
                ref={picker}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(event) => {
                  room.attach(Array.from(event.target.files ?? []));
                  // Picking the same file again after removing it still fires.
                  event.target.value = "";
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      size="icon-sm"
                      aria-label="Attach files"
                      disabled={room.sending || full}
                      onClick={() => picker.current?.click()}
                    />
                  }
                >
                  <Paperclip />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {full ? `Up to ${MAX_ATTACHMENTS} files per message` : "Attach images, PDFs or text for the crew to read"}
                </TooltipContent>
              </Tooltip>
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                disabled={room.sending || (!room.draft.trim() && room.files.length === 0)}
                aria-label="Send"
              >
                <SendHorizonal />
              </InputGroupButton>
            </div>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </form>
  );
}

function mentionOptionId(listId: string, botId: string) {
  return `${listId}-${botId}`;
}

/**
 * The @ picker's state for one message box: the token under the caret, the
 * bots it matches from the crew's own list, and which one is highlighted.
 * The rules are in mention-picker-logic.ts; this keeps them in step with the
 * textarea, which owns the caret.
 */
function useMentionPicker(room: Room, textarea: RefObject<HTMLTextAreaElement | null>) {
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // The token Escape closed the picker on, by where its @ is.
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Where the caret goes once the draft with the inserted mention has rendered.
  const pendingCaret = useRef<number | null>(null);

  const token = focused ? mentionTokenAt(room.draft, caret) : null;
  const matches: Bot[] = token ? filterMentions(BOTS, token.query) : [];
  const open = pickerOpen({ token, matches }, dismissed);
  const active = Math.min(highlight, Math.max(0, matches.length - 1));

  // A different word to complete starts from the top of its own list.
  const key = token ? `${token.start}:${token.query}` : null;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setHighlight(0);
    // Leaving the token forgets that it was dismissed; a new @ opens again.
    if (!token || token.start !== dismissed) setDismissed(null);
  }

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(at, at);
  }, [room.draft, textarea]);

  function pick(option: MentionOption) {
    if (!token) return;
    const next = insertMention(room.draft, token, option.id);
    pendingCaret.current = next.caret;
    room.setDraft(next.text);
    setCaret(next.caret);
    setFocused(true);
  }

  /** True when the key was the picker's, and the message box should leave it alone. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing) return false;
    const action = pickerKey(
      { token, matches, highlight: active },
      event.key,
      { shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey },
    );
    if (!action) return false;
    event.preventDefault();
    // Escape closes the list, not the panel the chat sits in.
    event.stopPropagation();
    if (action.kind === "move") setHighlight(action.highlight);
    else if (action.kind === "insert") pick(action.option);
    else setDismissed(token?.start ?? null);
    return true;
  }

  return {
    listId,
    open,
    matches,
    active,
    setHighlight,
    pick,
    onKeyDown,
    onCaret: (element: HTMLTextAreaElement) => {
      setFocused(true);
      setCaret(element.selectionStart ?? 0);
    },
    onBlur: () => setFocused(false),
  };
}

/** The list the @ picker shows above the message box: each bot's face, name and job. */
function MentionList({
  id,
  bots,
  active,
  onHighlight,
  onPick,
}: {
  id: string;
  bots: Bot[];
  active: number;
  onHighlight: (index: number) => void;
  onPick: (bot: Bot) => void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Mention a bot"
      className="absolute bottom-full left-0 z-50 mb-2 w-64 max-w-full overflow-hidden rounded-xl border border-fog bg-paper-white p-1 shadow-subtle-3"
    >
      {bots.map((bot, index) => (
        <li
          key={bot.id}
          id={mentionOptionId(id, bot.id)}
          role="option"
          aria-selected={index === active}
          // Keeps the caret in the message box while the mouse picks.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onPick(bot)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] tracking-[-0.32px] text-carbon",
            index === active && "bg-mist",
          )}
        >
          <span aria-hidden="true" className="inline-flex">
            <BotAvatar bot={bot} size={20} />
          </span>
          <span className="font-medium" style={{ color: botInk(bot.color) }}>
            {bot.name}
          </span>
          <span className="truncate text-[12px] text-ash">{bot.role}</span>
          <span className="ml-auto font-mono text-[11px] text-ash">@{bot.id}</span>
        </li>
      ))}
    </ul>
  );
}

/** A file in the composer, not sent yet: a thumbnail or an icon, and a way to take it off. */
function PendingFile({ item: { file, preview }, onRemove }: { item: PendingAttachment; onRemove: () => void }) {
  return (
    <span className="flex max-w-full items-center gap-1.5 rounded-lg border border-fog bg-paper-white py-1 pr-1 pl-1 text-[12px] text-foreground">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="size-6 rounded object-cover" />
      ) : (
        <FileText className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="max-w-40 truncate" title={file.name}>
        {file.name}
      </span>
      <span className="text-muted-foreground">{formatBytes(file.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/** The files sent with a message: images as thumbnails, the rest as links. */
function Attachments({ attachments, align }: { attachments: ChatAttachment[]; align: "start" | "end" }) {
  return (
    <div className={cn("flex max-w-full flex-wrap items-center gap-1.5", align === "end" ? "justify-end" : "justify-start")}>
      {attachments.map((file) => {
        const href = `/api/chat/attachments/${encodeURIComponent(file.id)}`;
        if (kindOf(file.mediaType) === "image") {
          return (
            <a key={file.id} href={href} target="_blank" rel="noreferrer" title={file.name} className="block overflow-hidden rounded-lg border border-fog">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={href} alt={file.name} loading="lazy" className="max-h-40 max-w-56 object-cover" />
            </a>
          );
        }
        return (
          <a
            key={file.id}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={file.name}
            className="flex max-w-full items-center gap-1.5 rounded-lg border border-fog bg-paper-white px-2 py-1 text-[12px] text-foreground hover:bg-linen"
          >
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="max-w-48 truncate">{file.name}</span>
            <span className="text-muted-foreground">{formatBytes(file.size)}</span>
          </a>
        );
      })}
    </div>
  );
}

function MentionBar({ room }: { room: Room }) {
  return (
    <div className="flex flex-wrap gap-1" aria-label="Mention a bot">
      {BOTS.map((bot) => (
        <Badge
          key={bot.id}
          variant="outline"
          render={<button type="button" onClick={() => room.mention(bot.id)} />}
          className={cn(
            "cursor-pointer gap-1 border-(--bot-edge) pl-1",
            // With nothing typed yet, hovering lights the bot up in its own color.
            !room.draft.trim() && "hover:border-(--bot-color) hover:bg-(--bot-tint)",
          )}
          style={
            {
              color: botInk(bot.color),
              "--bot-color": bot.color,
              "--bot-edge": `${bot.color}55`,
              "--bot-tint": `${bot.color}26`,
            } as CSSProperties
          }
        >
          <BotAvatar bot={bot} size={12} />@{bot.id}
        </Badge>
      ))}
    </div>
  );
}

function OffAlert({ enabled }: { enabled: boolean }) {
  if (enabled) return null;
  return (
    <div className="p-4">
      <Alert>
        <AlertTitle>Bots are off</AlertTitle>
        <AlertDescription>
          Nobody will answer here. Turn the crew on under Settings → Bots.
        </AlertDescription>
      </Alert>
    </div>
  );
}

/**
 * The panel's left border: drag it (or use the arrow keys) to widen the panel
 * toward the left, never narrower than it opened.
 */
function ResizeHandle({
  onResize,
  onResizingChange,
}: {
  onResize: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
}) {
  // The width the panel opened at, measured when a resize first starts.
  const base = useRef<number | null>(null);

  function panel(element: HTMLElement) {
    const popup = element.parentElement!;
    base.current ??= popup.getBoundingClientRect().width;
    return popup;
  }

  function clamp(next: number) {
    const max = Math.max(base.current ?? 0, window.innerWidth - RESIZE_MARGIN);
    return Math.round(Math.min(Math.max(next, base.current ?? 0), max));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    panel(event.currentTarget);
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizingChange(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const right = event.currentTarget.parentElement!.getBoundingClientRect().right;
    onResize(clamp(right - event.clientX));
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizingChange(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowLeft" ? RESIZE_STEP : event.key === "ArrowRight" ? -RESIZE_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    const current = panel(event.currentTarget).getBoundingClientRect().width;
    onResize(clamp(current + delta));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-ew-resize touch-none outline-none sm:block"
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ash group-focus-visible:bg-ash group-active:bg-ash" />
    </div>
  );
}

/**
 * Brings the newest line fully into view whenever one arrives, a bot's
 * reply included, so it can be read without scrolling. The scroller's own
 * follow stops once you scroll up; a new message always comes back down.
 */
function FollowLatest({ lastId, thinking }: { lastId: string | null; thinking: boolean }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (!lastId && !thinking) return;
    // After layout, so a tall reply is measured before scrolling to its end.
    const frame = requestAnimationFrame(() => scrollToEnd({ behavior: "smooth" }));
    return () => cancelAnimationFrame(frame);
  }, [lastId, thinking, scrollToEnd]);
  return null;
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** One line of the room: your bubble, a bot's bubble, or a crew event. */
function Line({ message, onOpenCard }: { message: ChatMessage; onOpenCard: (cardId: string) => void }) {
  if (message.kind === "event") {
    const bot = isBotId(message.author) ? getBot(message.author) : null;
    const body = (
      <>
        {bot ? <span style={{ color: botInk(bot.color) }}>{bot.name}</span> : null}
        {bot ? " · " : ""}
        <Body text={message.body} />
      </>
    );
    return (
      <Marker
        variant="default"
        render={message.cardId ? <button type="button" onClick={() => onOpenCard(message.cardId!)} /> : undefined}
        className={cn("text-[12px]", message.cardId && "cursor-pointer hover:text-foreground")}
        title={message.cardId ? "Open the card" : undefined}
      >
        {bot ? (
          <MarkerIcon>
            <BotAvatar bot={bot} size={16} />
          </MarkerIcon>
        ) : null}
        <MarkerContent>{body}</MarkerContent>
      </Marker>
    );
  }

  if (message.author === "you") {
    return (
      <Message align="end">
        <MessageContent>
          {message.attachments?.length ? <Attachments attachments={message.attachments} align="end" /> : null}
          {message.body ? (
            <Bubble variant="default" align="end">
              <BubbleContent className="whitespace-pre-wrap">
                <Body text={message.body} />
              </BubbleContent>
            </Bubble>
          ) : null}
          <MessageFooter>{time(message.createdAt)}</MessageFooter>
        </MessageContent>
      </Message>
    );
  }

  const bot = getBot(message.author);
  return (
    <Message align="start">
      <MessageAvatar className="bg-transparent">
        <BotAvatar bot={bot} size={28} />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>
          <span style={{ color: botInk(bot.color) }}>{bot.name}</span>
        </MessageHeader>
        <Bubble variant="secondary" align="start">
          <BubbleContent className="whitespace-pre-wrap">
            <Body text={message.body} />
          </BubbleContent>
        </Bubble>
        <MessageFooter>{time(message.createdAt)}</MessageFooter>
      </MessageContent>
    </Message>
  );
}

/** Light Markdown, with @mentions in the bot's color. */
function Body({ text }: { text: string }) {
  return <>{parseInline(text).map((inline, index) => renderInline(inline, index))}</>;
}

function renderInline(inline: Inline, key: number): ReactNode {
  switch (inline.kind) {
    case "code":
      return (
        <code key={key} className="rounded bg-foreground/10 px-1 font-mono text-[12px]">
          {inline.text}
        </code>
      );
    case "bold":
      return <strong key={key}>{inline.children.map(renderInline)}</strong>;
    case "italic":
      return <em key={key}>{inline.children.map(renderInline)}</em>;
    case "link":
      return (
        <a key={key} href={inline.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {inline.text}
        </a>
      );
    default:
      return <Mentions key={key} text={inline.text} />;
  }
}

function Mentions({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const index = (match.index ?? 0) + match[1].length;
    if (index > last) parts.push(text.slice(last, index));
    const id = match[2].toLowerCase();
    const bot = isBotId(id) ? getBot(id) : null;
    parts.push(
      <span key={index} className="font-medium" style={bot ? { color: bot.color } : undefined}>
        @{match[2]}
      </span>,
    );
    last = index + match[2].length + 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
