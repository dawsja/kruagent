"use client";

import { Ban, Box, Eye, FolderGit2, GitMerge, MessagesSquare, Monitor, Pencil, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { BotBadge } from "@/components/hq/bot-avatar";
import { BoxDesktop } from "@/components/hq/box-desktop";
import { BoxTerminal, type TerminalTarget } from "@/components/hq/box-terminal";
import { requestNotificationPermission, useChatUnread, useCrewNotices } from "@/components/hq/crew-notices";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { HqHeader } from "@/components/hq/hq-header";
import { RunLog } from "@/components/hq/run-log";
import { RunElapsed, RunStatus } from "@/components/hq/run-status";
import { focusChatWindow, openChatWindow, postChatEvent, useChatEvents } from "@/components/hq/chat-window";
import { TeamChat } from "@/components/hq/team-chat";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ModelPicker,
  type ModelPickerOption,
} from "@/components/hq/model-picker";
import { diffRows, diffStats } from "@/lib/hq/diff";
import { feedbackEvent } from "@/lib/hq/github-feedback-logic";
import { logHeadline } from "@/lib/hq/run-log";
import { botForStage, getBot } from "@/lib/hq/bots/registry";
import { modelLabel, modelOptionsFor } from "@/lib/hq/models";
import { throttle, type RunSummary } from "@/lib/hq/board-logic";
import { isActiveStage, isModelProvider, type BotJob, type Card, type ColumnId, type PrFeedback, type Run } from "@/lib/hq/types";

type PublicConnection = {
  id: string;
  provider: string;
  label: string;
  connected: boolean;
  meta?: Record<string, string>;
};

type Repo = { full_name: string; default_branch: string; private?: boolean };

const COLUMN_META: {
  id: ColumnId;
  index: string;
  label: string;
  hint: string;
  empty: string;
}[] = [
  {
    id: "drop",
    index: "01",
    label: "Drop",
    hint: "Queue work",
    empty: "Drop a card here",
  },
  {
    id: "run",
    index: "02",
    label: "Run",
    hint: "Agent in flight",
    empty: "Drag a card here to run",
  },
  {
    id: "review",
    index: "03",
    label: "Review",
    hint: "PR ready",
    empty: "Finished work lands here",
  },
];

export function HqBoard({
  initialError,
  defaultRepo,
}: {
  initialError: string | null;
  defaultRepo: string | null;
}) {
  const [cards, setCards] = useState<Card[]>([]);
  // Summaries: the open card's run is fetched in full into `detail`.
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<Run | null>(null);
  // The crew's newest job per card, and whether the crew is on at all.
  const [jobs, setJobs] = useState<BotJob[]>([]);
  const [botsEnabled, setBotsEnabled] = useState(false);
  // What GitHub said about the crew's pull requests, newest first.
  const [prFeedback, setPrFeedback] = useState<PrFeedback[]>([]);
  const [autoPush, setAutoPush] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // The room is open in its own browser window (see chat-window.ts).
  const [chatPopped, setChatPopped] = useState(false);
  const chatWindow = useRef<Window | null>(null);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [repo, setRepo] = useState(defaultRepo ?? "");
  const [model, setModel] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  // The box desktop keeps running while hidden; this only shows or hides it.
  const [desktopOpen, setDesktopOpen] = useState(false);
  // In-place edit of a card's task, repo and model. Keyed by card id, so
  // opening another card shows that card, not a stale draft.
  const [draft, setDraft] = useState<{
    id: string;
    title: string;
    body: string;
    repo: string;
    model: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  // The new-card dialog, opened from the header's plus button.
  const [newCardOpen, setNewCardOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [revisionNote, setRevisionNote] = useState("");
  const [revising, setRevising] = useState(false);
  const [followUpNote, setFollowUpNote] = useState("");
  const [followingUp, setFollowingUp] = useState(false);
  // Repo and model from the last card, read from this browser.
  const [remembered, setRemembered] = useState<{ repo: string; model: string } | null>(null);
  // Box shells stay open while hidden; keyed by run id, or "box" for ~/workspace.
  const [shells, setShells] = useState<Record<string, string>>({});
  // Press-and-hold before a drag: a quick click opens the card, a held one
  // (the ring fills) lifts it. Moving during the hold cancels both.
  const [hold, setHold] = useState<{ id: string; x: number; y: number } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    x: number;
    y: number;
    width: number;
    offsetX: number;
    offsetY: number;
    originX: number;
    originY: number;
    over: ColumnId | null;
  } | null>(null);

  useEffect(() => {
    if (!drag) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [drag]);

  const selected = cards.find((card) => card.id === selectedId) ?? null;
  const selectedRun = runs.find((run) => run.id === selected?.runId) ?? null;
  // The open card's run in full, only once it matches the summary's run.
  const selectedDetail = detail && detail.id === selectedRun?.id ? detail : null;
  const selectedJob = jobs.find((job) => job.cardId === selected?.id) ?? null;
  // While the crew has the card, the run waits for approval internally;
  // the person gets it once Bibi is done.
  const crewActive = Boolean(selectedJob && isActiveStage(selectedJob.stage));
  // A run waiting for approval on a pull request's branch: approving pushes.
  const followUpOf =
    selectedRun?.status === "needs_approval" && selectedRun.headBranch && selectedRun.prUrl ? selectedRun : null;
  // An approved run whose pull request is still open can be followed up on.
  const canFollowUp = Boolean(
    selectedRun?.status === "approved" &&
      selectedRun.prUrl &&
      selectedRun.prState !== "merged" &&
      selectedRun.prState !== "closed" &&
      selected?.status === "approved" &&
      !crewActive,
  );
  const pendingFeedback = prFeedback.filter((item) => item.cardId === selected?.id && !item.handledBy);
  // Every run the card has had, newest first: rounds, revisions, follow-ups.
  const cardRuns = useMemo(() => runs.filter((run) => run.cardId === selected?.id), [runs, selected?.id]);
  const editing = draft && draft.id === selected?.id ? draft : null;
  const setEditing = setDraft;
  const confirmDelete = confirmDeleteId !== null && confirmDeleteId === selected?.id;

  // Esc closes what's on top: a terminal or the desktop handle their own, then an edit, then the panel.
  useEffect(() => {
    if (!selectedId || terminal || desktopOpen || chatOpen || newCardOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editing) setDraft(null);
      else setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, terminal, desktopOpen, chatOpen, newCardOpen, editing]);
  // Polled while anything can still move on its own. A pull request that was
  // closed without merging cannot, so it stops the poll the same as a merge.
  // With the Team room open, the crew can add cards at any moment.
  const watching = chatOpen || chatPopped || jobs.some((job) => isActiveStage(job.stage)) || cards.some((card) => {
    if (card.status === "running") return true;
    if (card.column !== "review" || card.status === "merged") return false;
    return runs.find((run) => run.id === card.runId)?.prState !== "closed";
  });

  const load = useCallback(
    () =>
      fetch("/api/board")
        .then((res) => res.json())
        .then(
          (data: {
            cards: Card[];
            runs: RunSummary[];
            connections: PublicConnection[];
            jobs?: BotJob[];
            botsEnabled?: boolean;
            autoPush?: boolean;
            prFeedback?: PrFeedback[];
          }) => {
          setCards(data.cards);
          setRuns(data.runs);
          setConnections(data.connections);
          setJobs(data.jobs ?? []);
          setBotsEnabled(Boolean(data.botsEnabled));
          setAutoPush(Boolean(data.autoPush));
          setPrFeedback(data.prFeedback ?? []);
          setLoaded(true);
          setRemembered((current) => current ?? readRemembered());
          // Settings links here with ?desktop=1 to open the box desktop,
          // where the person signs in to Claude Code. Cleared once seen.
          if (new URLSearchParams(window.location.search).get("desktop") === "1") {
            setDesktopOpen(true);
            window.history.replaceState(null, "", window.location.pathname);
          }
        },
        ),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openCardFromNotice = useCallback((cardId: string) => {
    setChatOpen(false);
    setSelectedId(cardId);
  }, []);
  useCrewNotices({ jobs, cards, runs, loaded, onOpenCard: openCardFromNotice });
  const unread = useChatUnread({ open: chatOpen || chatPopped, enabled: botsEnabled, onActivity: load });

  // The popped-out window says when it opens and closes. Docking it brings
  // the room back to the side panel; closing it just closes the chat. A ping
  // finds one left open by a reload.
  useChatEvents((event) => {
    if (event.type === "popped") {
      setChatOpen(false);
      setChatPopped(true);
    } else if (event.type === "docked") {
      chatWindow.current = null;
      setChatPopped(false);
      setChatOpen(true);
    } else if (event.type === "closed") {
      chatWindow.current = null;
      setChatPopped(false);
    } else if (event.type === "open-card") {
      setSelectedId(event.cardId);
      window.focus();
    } else if (event.type === "activity") {
      void load();
    }
  });
  useEffect(() => {
    postChatEvent({ type: "ping" });
  }, []);
  // In case the window went away without a word (a crash, a killed tab).
  useEffect(() => {
    if (!chatPopped) return;
    const timer = window.setInterval(() => {
      if (!chatWindow.current?.closed) return;
      chatWindow.current = null;
      setChatPopped(false);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [chatPopped]);

  const popOutChat = useCallback(() => {
    const opened = openChatWindow();
    if (!opened) return false;
    chatWindow.current = opened;
    // The panel shuts behind it, so closing the window leaves nothing to reopen.
    setChatOpen(false);
    setChatPopped(true);
    return true;
  }, []);
  const unreadBot = unread ? getBot(unread) : null;

  // The board fetches when /api/events says something changed, at most every
  // half second while an agent is writing its log. Polling stays as the
  // safety net: rarely while the stream is up, as often as before when not.
  const reload = useMemo(() => throttle(() => void load(), 500), [load]);
  const live = useLiveEvents((message) => {
    if (message.topic !== "chat") reload();
  });
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => {
      void load();
    }, pollInterval(live, 1500));
    return () => window.clearInterval(timer);
  }, [watching, live, load]);

  // The open card's run in full: fetched again whenever its summary says
  // the run moved (a new log line, a new status).
  const detailKey = selectedRun ? `${selectedRun.id}|${selectedRun.logCount}|${selectedRun.updatedAt}` : null;
  useEffect(() => {
    if (!detailKey) return;
    const runId = detailKey.split("|")[0];
    let cancelled = false;
    void fetch(`/api/runs/${runId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { run?: Run } | null) => {
        if (!cancelled && data?.run) setDetail(data.run);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [detailKey]);

  useEffect(() => {
    if (!connections.some((item) => item.provider === "github")) return;
    void fetch("/api/github/repos")
      .then((res) => res.json())
      .then((data: { repos?: Repo[] }) => {
        const list = data.repos ?? [];
        setRepos(list);
        // Keep the saved repo while GitHub still lists it, else the one used
        // last in this browser, else the most recently pushed, listed first.
        const last = readRemembered().repo;
        setRepo((current) =>
          list.some((item) => item.full_name === current)
            ? current
            : list.some((item) => item.full_name === last)
              ? last
              : (list[0]?.full_name ?? current),
        );
      });
  }, [connections]);

  // Built-in lists show until /api/models answers with the live lists.
  const fallbackModelOptions = useMemo(
    () => modelOptionsFor(connections.filter((item) => item.connected)),
    [connections],
  );
  const modelsKey = connections
    .filter((item) => item.connected && isModelProvider(item.provider))
    .map(
      (item) =>
        `${item.id}:${item.provider}:${item.label}:${item.meta?.name ?? ""}:${item.meta?.models ?? ""}:${item.meta?.listedModels ?? ""}`,
    )
    .join("|");
  const [liveModels, setLiveModels] = useState<{
    key: string;
    options: ModelPickerOption[];
  } | null>(null);

  // Asked once the board is in, and again when the connections change. The
  // answer can hold models with no connection row at all: Claude Code's,
  // when the CLI in the box is signed in.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void fetch("/api/models")
      .then((res) => res.json())
      .then((data: { options?: ModelPickerOption[] }) => {
        if (!cancelled && data.options) {
          setLiveModels({ key: modelsKey, options: data.options });
        }
      })
      .catch(() => {
        /* keep the built-in lists */
      });
    return () => {
      cancelled = true;
    };
  }, [modelsKey, loaded]);

  const modelOptions =
    liveModels?.key === modelsKey ? liveModels.options : fallbackModelOptions;
  const hasModelProvider =
    modelOptions.length > 0 ||
    connections.some((item) => item.connected && isModelProvider(item.provider));

  // The picked model, else the one used last in this browser, else the first.
  const activeModel = modelOptions.some((item) => item.id === model)
    ? model
    : modelOptions.some((item) => item.id === remembered?.model)
      ? (remembered?.model ?? "")
      : (modelOptions[0]?.id ?? "");

  const repoOptions = useMemo(
    () =>
      repos.map((item) => {
        const [owner, name] = item.full_name.split("/");
        return {
          id: item.full_name,
          name: name ?? item.full_name,
          provider: owner ?? "GitHub",
          description: item.full_name,
          badge: item.private ? "Private" : undefined,
          keywords: [item.full_name, owner, name].filter(Boolean) as string[],
          icon: <FolderGit2 className="size-4 text-muted-foreground" />,
        };
      }),
    [repos],
  );

  async function createCard() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        repo: repo || null,
        model: activeModel,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create card");
      return;
    }
    setTitle("");
    setBody("");
    rememberChoice(repo, activeModel);
    setNewCardOpen(false);
    await load();
  }

  async function moveCard(id: string, column: ColumnId) {
    if (column === "review") return;
    if (column === "run") {
      void runCard(id);
      return;
    }
    setError(null);
    const res = await fetch(`/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column }),
    });
    // The crew refuses a drag while it has the card; say so instead of
    // letting the card jump back on the next poll without a word.
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Could not move the card");
    }
    await load();
  }

  async function runCard(id: string) {
    setError(null);
    setSelectedId(id);
    const res = await fetch(`/api/cards/${id}/run`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Run failed");
    await load();
  }

  async function approveRun(id: string) {
    setError(null);
    setApproving(id);
    const res = await fetch(`/api/runs/${id}/approve`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setApproving(null);
    if (!res.ok) setError(data.error ?? "Could not open the pull request");
    await load();
  }

  async function reviseRun(id: string) {
    const note = revisionNote.trim();
    if (!note) return;
    setError(null);
    setRevising(true);
    const res = await fetch(`/api/runs/${id}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setRevising(false);
    if (!res.ok) {
      setError(data.error ?? "Could not send the request");
      return;
    }
    setRevisionNote("");
    await load();
  }

  async function cancelRun(id: string) {
    setError(null);
    const res = await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not cancel");
    await load();
  }

  async function followUp(id: string) {
    setError(null);
    setFollowingUp(true);
    const res = await fetch(`/api/runs/${id}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: followUpNote.trim() }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setFollowingUp(false);
    if (!res.ok) {
      setError(data.error ?? "Could not start the follow-up");
      return;
    }
    setFollowUpNote("");
    await load();
  }

  async function reopenPr(id: string) {
    setError(null);
    const res = await fetch(`/api/runs/${id}/reopen`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) setError(data.error ?? "Could not reopen the pull request");
    await load();
  }

  /** Deletes the merged cards in Review; their pull requests are done. */
  async function clearMerged() {
    setError(null);
    const merged = cards.filter((card) => card.column === "review" && card.status === "merged");
    await Promise.all(merged.map((card) => fetch(`/api/cards/${card.id}`, { method: "DELETE" })));
    if (merged.some((card) => card.id === selectedId)) setSelectedId(null);
    await load();
  }

  function startEditing(card: Card) {
    setError(null);
    setEditing({
      id: card.id,
      title: card.title,
      body: card.body,
      repo: card.repo ?? "",
      model: card.model ?? "",
    });
  }

  async function saveCard(id: string) {
    if (!editing || !editing.title.trim()) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: editing.title,
        body: editing.body,
        repo: editing.repo || null,
        model: editing.model || null,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setSaving(false);
    if (!res.ok) {
      setError(data.error ?? "Could not save the card");
      return;
    }
    setEditing(null);
    await load();
  }

  async function deleteCard(id: string) {
    setError(null);
    const res = await fetch(`/api/cards/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Could not delete card");
      return;
    }
    if (selectedId === id) setSelectedId(null);
    await load();
  }

  function clearHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

  const columnCards = (id: ColumnId) =>
    cards.filter((card) => card.column === id);

  return (
    <div className="blueprint-grid flex min-h-dvh flex-col bg-linen text-carbon">
      <HqHeader
        actions={
          <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="New card"
                  onClick={() => {
                    setError(null);
                    setNewCardOpen(true);
                  }}
                  className="rounded-full border-fog bg-transparent text-ash hover:border-brand hover:bg-transparent hover:text-carbon"
                />
              }
            >
              <Plus className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="bottom">New card</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={unreadBot ? `Team chat, new from ${unreadBot.name}` : "Team chat"}
                  onClick={() => {
                    if (chatPopped) {
                      if (chatWindow.current && !chatWindow.current.closed) chatWindow.current.focus();
                      else if (!focusChatWindow()) setChatPopped(false);
                      return;
                    }
                    setChatOpen(true);
                    if (botsEnabled) requestNotificationPermission();
                  }}
                  className="relative rounded-full border-fog bg-transparent text-ash hover:border-brand hover:bg-transparent hover:text-carbon"
                />
              }
            >
              <MessagesSquare className="size-4" />
              {unreadBot ? (
                <span
                  aria-hidden="true"
                  className="absolute top-0 right-0 size-2.5 rounded-full ring-2 ring-linen"
                  style={{ backgroundColor: unreadBot.color }}
                />
              ) : null}
            </TooltipTrigger>
            <TooltipContent side="bottom">Team chat</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    aria-label="Open the box"
                    className="rounded-full border border-fog p-2 text-ash outline-none hover:border-brand hover:text-carbon focus-visible:ring-2 focus-visible:ring-ring data-popup-open:border-brand data-popup-open:text-carbon"
                  />
                }
              >
                <Box className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="bottom">Open the box</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-40 min-w-40">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => {
                    setDesktopOpen(false);
                    setTerminal({ kind: "shell", title: "Box · Terminal" });
                  }}
                >
                  <SquareTerminal />
                  Terminal
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setTerminal(null);
                    setDesktopOpen(true);
                  }}
                >
                  <Monitor />
                  Desktop
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          </>
        }
      />

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-5 p-4 sm:p-6">
        {error && !newCardOpen ? (
          <p className="text-[13px] text-ember">{error}</p>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
          {COLUMN_META.map((column) => {
            const items = columnCards(column.id);
            const hot = drag?.over === column.id;
            return (
              <section
                key={column.id}
                data-column={column.id}
                className={cn(
                  "flex min-h-[28rem] flex-col rounded-2xl border bg-paper-white p-3 transition-colors sm:p-4",
                  hot ? "border-brand bg-mist/40" : "border-fog",
                )}
              >
                <div className="mb-3 flex items-center justify-between gap-3 px-1">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          "font-mono text-[11px]",
                          hot ? "text-brand-ink" : "text-ash",
                        )}
                      >
                        {column.index}
                      </span>
                      <h2 className="text-[15px] font-medium tracking-[-0.32px] text-carbon">
                        {column.label}
                      </h2>
                    </div>
                    <p className="mt-0.5 text-[12px] text-ash">{column.hint}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {column.id === "review" && items.some((card) => card.status === "merged") ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={() => setConfirmClearOpen(true)}
                              aria-label="Clear merged"
                              className="grid size-6 place-items-center rounded-full border border-fog text-ash hover:text-carbon"
                            />
                          }
                        >
                          <Trash2 className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipContent>Clear merged</TooltipContent>
                      </Tooltip>
                    ) : null}
                    <span className="rounded-full border border-fog px-2 py-0.5 font-mono text-[11px] text-ash">
                      {String(items.length).padStart(2, "0")}
                    </span>
                  </div>
                </div>
                <CardStack
                  stacked={items.length >= STACK_FROM}
                  className={cn(
                    "flex flex-1 flex-col rounded-xl p-1 transition-colors",
                    hot && "bg-linen/80 ring-1 ring-brand/40",
                  )}
                >
                  {items.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-fog px-4 py-10 text-center text-[13px] text-ash">
                      {column.empty}
                    </div>
                  ) : (
                    items.map((card) => (
                      <BoardCard
                        key={card.id}
                        card={card}
                        run={runs.find((item) => item.id === card.runId)}
                        job={jobs.find((item) => item.cardId === card.id)}
                        feedback={prFeedback.filter((item) => item.cardId === card.id && !item.handledBy).length}
                        selected={selectedId === card.id}
                        dimmed={drag?.id === card.id}
                        onSelect={() => setSelectedId(card.id)}
                        holding={hold?.id === card.id}
                        onPickup={(event) => {
                          if (event.button !== 0) return;
                          const node = event.currentTarget;
                          const rect = node.getBoundingClientRect();
                          node.setPointerCapture(event.pointerId);
                          const start = { x: event.clientX, y: event.clientY };
                          setHold({ id: card.id, ...start });
                          clearHold();
                          holdTimer.current = window.setTimeout(() => {
                            holdTimer.current = null;
                            setHold(null);
                            setDrag({
                              id: card.id,
                              x: start.x,
                              y: start.y,
                              width: rect.width,
                              offsetX: start.x - rect.left,
                              offsetY: start.y - rect.top,
                              originX: start.x,
                              originY: start.y,
                              over: column.id,
                            });
                          }, HOLD_MS);
                        }}
                        onMove={(event) => {
                          if (hold?.id === card.id) {
                            // Scrolling or a shaky press: neither open nor lift.
                            if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) {
                              clearHold();
                              setHold(null);
                            }
                            return;
                          }
                          if (drag?.id !== card.id) return;
                          const over = columnAt(event.clientX, event.clientY);
                          setDrag({
                            ...drag,
                            x: event.clientX,
                            y: event.clientY,
                            over,
                          });
                        }}
                        onRelease={(event) => {
                          if (hold?.id === card.id) {
                            // Let go before the ring filled: a click.
                            clearHold();
                            setHold(null);
                            if (event.type !== "pointercancel") setSelectedId(card.id);
                            return;
                          }
                          if (drag?.id !== card.id) return;
                          const over = columnAt(event.clientX, event.clientY);
                          setDrag(null);
                          if (event.type !== "pointercancel" && over && over !== column.id) {
                            void moveCard(card.id, over);
                          }
                        }}
                      />
                    ))
                  )}
                </CardStack>
              </section>
            );
          })}
        </div>
      </div>

      {drag
        ? (() => {
            const held = cards.find((item) => item.id === drag.id);
            if (!held) return null;
            return (
              <div
                className="pointer-events-none fixed z-[80]"
                style={{
                  left: drag.x - drag.offsetX,
                  top: drag.y - drag.offsetY,
                  width: drag.width,
                  transform: "rotate(2deg) scale(1.03)",
                }}
              >
                <BoardCard
                  card={held}
                  run={runs.find((item) => item.id === held.runId)}
                  job={jobs.find((item) => item.cardId === held.id)}
                  selected
                  lifting
                />
              </div>
            );
          })()
        : null}

      {selected ? (
        // Takes the whole viewport below the header; the tooltip portals into
        // the body, which sits below the terminal and desktop overlays only.
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="card-panel-title"
          className="fixed inset-x-0 bottom-0 top-[var(--hq-header-h,0px)] z-40 flex flex-col overflow-y-auto overflow-x-hidden overscroll-contain bg-paper-white"
        >
          <div className="sticky top-0 z-10 border-b border-fog bg-paper-white">
            <div className="mx-auto flex w-full max-w-5xl items-start justify-between gap-3 px-4 py-4 sm:px-8 sm:py-5">
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[-0.32px] text-ash">
                  {statusLabel(selected.status)}
                </p>
                <h2
                  id="card-panel-title"
                  className="mt-1.5 break-words text-[18px] font-medium leading-snug tracking-[-0.32px] text-carbon sm:text-[22px]"
                >
                  {selected.title}
                </h2>
                <p className="mt-1.5 truncate text-[12px] text-ash">
                  {selected.repo ?? "No repo"} · {modelLabel(selected.model)}
                  {selected.issueNumber ? (
                    <>
                      {" · "}
                      {selected.issueUrl ? (
                        <a href={selected.issueUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-carbon">
                          issue #{selected.issueNumber}
                        </a>
                      ) : (
                        `issue #${selected.issueNumber}`
                      )}
                    </>
                  ) : null}
                </p>
                {selectedJob ? (
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-ash">
                    {crewActive && botForStage(selectedJob.stage) ? (
                      <>
                        Handled by the crew
                        <BotBadge
                          bot={botForStage(selectedJob.stage)!}
                          label={`${botForStage(selectedJob.stage)!.name} ${botForStage(selectedJob.stage)!.verb}`}
                        />
                      </>
                    ) : selectedJob.stage === "done" ? (
                      `Built by the crew · Lulu ${selectedJob.reviewVerdict === "pass" ? "passed it" : "had concerns"}${selectedJob.rounds ? ` after ${selectedJob.rounds} round${selectedJob.rounds === 1 ? "" : "s"}` : ""}`
                    ) : selectedJob.stage === "failed" ? (
                      `The crew stopped: ${selectedJob.error ?? "unknown reason"}`
                    ) : (
                      "The crew let this one go"
                    )}
                  </p>
                ) : null}
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setSelectedId(null)}
                      aria-label="Close card"
                      className="-mr-2 -mt-1 shrink-0 rounded-full p-2 text-ash outline-none hover:bg-mist hover:text-carbon focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <X className="size-5" />
                </TooltipTrigger>
                <TooltipContent side="bottom">Close</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="mx-auto w-full max-w-5xl flex-1 px-4 pb-10 pt-1 sm:px-8 sm:pb-16 sm:pt-2">
          {editing ? (
            <form
              className="mt-5 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void saveCard(selected.id);
              }}
            >
              <div className="flex h-11 items-center rounded-full border border-border bg-muted px-4 focus-within:ring-2 focus-within:ring-ring">
                <input
                  value={editing.title}
                  onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                  placeholder="Title"
                  className="min-w-0 flex-1 bg-transparent text-sm tracking-[-0.32px] text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="rounded-[22px] border border-border bg-muted px-4 py-3 focus-within:ring-2 focus-within:ring-ring">
                <textarea
                  value={editing.body}
                  onChange={(event) => setEditing({ ...editing, body: event.target.value })}
                  placeholder="What should the crew do?"
                  rows={5}
                  className="w-full resize-none bg-transparent text-sm tracking-[-0.32px] text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <ModelPicker
                  models={repoOptions}
                  value={editing.repo || undefined}
                  onValueChange={(value) => setEditing({ ...editing, repo: value })}
                  placeholder="Repo"
                  emptyIcon={<FolderGit2 className="size-4 text-muted-foreground" />}
                  emptyTitle="No repos found"
                  emptyHint="Give the Kru GitHub App access to a repo, then reload."
                  searchPlaceholder="Search repos…"
                  side="bottom"
                  className="min-h-11"
                />
                <ModelPicker
                  models={modelOptions}
                  value={editing.model || undefined}
                  onValueChange={(value) => setEditing({ ...editing, model: value })}
                  placeholder="Model"
                  emptyHint="Add an API endpoint in Settings."
                  side="bottom"
                  className="min-h-11"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={saving || !editing.title.trim()}
                  className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : selected.body ? (
            <p className="mt-5 whitespace-pre-wrap text-[14px] leading-6 text-graphite">
              {selected.body}
            </p>
          ) : null}
          {!editing && selected.status === "error" ? (
            <div role="alert" className="mt-5 rounded-xl border border-ember/40 bg-ember/10 p-4">
              <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ember">
                {selectedRun?.prState === "closed"
                  ? "Pull request closed"
                  : !selectedRun && selectedJob?.stage === "failed"
                    ? "The crew stopped"
                    : "Last run failed"}
              </p>
              <p className="mt-1 break-words text-[13px] leading-6 text-carbon">
                {selectedRun?.error ??
                  (selectedJob?.stage === "failed" && selectedJob.error ? selectedJob.error : null) ??
                  selectedRun?.lastLog ??
                  "The run stopped without a reason."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedRun?.prState === "closed" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reopenPr(selectedRun.id)}
                    className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground disabled:opacity-50"
                  >
                    Reopen PR
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runCard(selected.id)}
                  className={cn(
                    "rounded-full px-4 py-2 text-[13px] font-medium disabled:opacity-50",
                    selectedRun?.prState === "closed" ? "border border-fog text-carbon" : "bg-brand text-brand-foreground",
                  )}
                >
                  {selectedRun?.prState === "closed" ? "Start over" : "Retry run"}
                </button>
                <button
                  type="button"
                  onClick={() => startEditing(selected)}
                  className="flex items-center gap-1.5 rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon"
                >
                  <Pencil className="size-3.5" />
                  Edit task
                </button>
              </div>
            </div>
          ) : null}
          {editing ? null : (
          <div className="mt-6 flex flex-wrap gap-2">
            {selected.column === "drop" ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runCard(selected.id)}
                  className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground disabled:opacity-50"
                >
                  Run agent
                </button>
                <button
                  type="button"
                  onClick={() => startEditing(selected)}
                  className="flex items-center gap-1.5 rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon"
                >
                  <Pencil className="size-3.5" />
                  Edit
                </button>
              </>
            ) : null}
            {selectedRun?.status === "needs_approval" && !crewActive ? (
              <>
                <button
                  type="button"
                  disabled={approving === selectedRun.id}
                  onClick={() => void approveRun(selectedRun.id)}
                  className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground disabled:opacity-50"
                >
                  {approving === selectedRun.id
                    ? followUpOf
                      ? "Pushing…"
                      : "Opening pull request…"
                    : followUpOf
                      ? `Approve and push to PR${followUpOf.prNumber ? ` #${followUpOf.prNumber}` : ""}`
                      : "Approve and open PR"}
                </button>
                <button
                  type="button"
                  disabled={approving === selectedRun.id}
                  onClick={() => void cancelRun(selectedRun.id)}
                  className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon disabled:opacity-50"
                >
                  Discard
                </button>
              </>
            ) : null}
            {selectedRun?.prUrl ? (
              <a
                href={selectedRun.prUrl}
                className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground"
                target="_blank"
                rel="noreferrer"
              >
                {selected.status === "merged"
                  ? "Merged PR"
                  : selectedRun.prState === "closed"
                    ? "Closed PR"
                    : "Open pull request"}
              </a>
            ) : null}
            {selected.status === "running" && (selectedRun || selected.runId) ? (
              <>
                <IconAction
                  label="Watch agent"
                  onClick={() =>
                    setTerminal({
                      kind: "watch",
                      runId: (selectedRun?.id ?? selected.runId) as string,
                      title: `Agent · ${selected.title}`,
                    })
                  }
                >
                  <Eye className="size-4" />
                </IconAction>
                <IconAction
                  label="Cancel run"
                  onClick={() =>
                    void cancelRun((selectedRun?.id ?? selected.runId) as string)
                  }
                >
                  <Ban className="size-4" />
                </IconAction>
              </>
            ) : null}
            {/*
              The workspace outlives the run that made it, so a reviewer can
              stand in the tree the diff came from — run the failing test,
              look at what the agent didn't propose — before deciding. It is
              offered while the box is likely to still have it (a failed run
              keeps it when the agent finished but its changes couldn't be
              collected); opening it
              says so plainly when the box has already let it go.
            */}
            {(selected.status === "running" ||
              selected.status === "needs_approval" ||
              selected.status === "error") &&
            (selectedRun || selected.runId) ? (
              <IconAction
                label="Shell in workspace"
                onClick={() =>
                  setTerminal({
                    kind: "shell",
                    runId: (selectedRun?.id ?? selected.runId) as string,
                    title: `Shell · ${selected.repo?.split("/")[1] ?? "workspace"}`,
                  })
                }
              >
                <SquareTerminal className="size-4" />
              </IconAction>
            ) : null}
            {confirmDelete ? (
              <span className="flex flex-wrap items-center gap-2 rounded-full border border-ember/40 bg-ember/10 py-1 pl-4 pr-1 text-[13px] text-carbon">
                Delete this card and its runs?
                <button
                  type="button"
                  onClick={() => void deleteCard(selected.id)}
                  className="rounded-full bg-ember px-3 py-1 text-[12px] font-medium text-white"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(null)}
                  className="rounded-full border border-fog bg-paper-white px-3 py-1 text-[12px] font-medium text-carbon"
                >
                  Keep
                </button>
              </span>
            ) : (
              <IconAction
                label="Delete card"
                onClick={() => setConfirmDeleteId(selected.id)}
                className="text-ember hover:border-ember hover:text-ember"
              >
                <Trash2 className="size-4" />
              </IconAction>
            )}
          </div>
          )}
          {selected.status === "running" ? (
            <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-fog bg-mist px-4 py-3">
              <RunStatus label={logHeadline(selectedRun?.lastLog ?? undefined) ?? "Starting"} />
              {selectedRun ? <RunElapsed since={selectedRun.createdAt} /> : null}
            </div>
          ) : null}
          {selectedRun?.status === "applying" ? (
            <div className="mt-6 rounded-xl border border-fog bg-mist px-4 py-3">
              <RunStatus label="Opening pull request" />
            </div>
          ) : null}
          {crewActive && selectedJob && selected.status !== "running" ? (
            <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-fog bg-mist px-4 py-3">
              <RunStatus
                label={
                  selectedJob.stage === "test"
                    ? "Kiko is running the repo's checks"
                    : selectedJob.stage === "review"
                      ? "Lulu is reviewing the diff"
                      : "Bibi is writing it up"
                }
              />
              {selectedRun ? <RunElapsed since={selectedRun.createdAt} /> : null}
            </div>
          ) : null}
          {selectedRun?.status === "needs_approval" && !crewActive ? (
            <p className="mt-6 text-[13px] leading-6 text-graphite">
              {followUpOf
                ? `Review the follow-up below: only what this round adds to the pull request. Approving pushes it to PR${followUpOf.prNumber ? ` #${followUpOf.prNumber}` : ""} as one more commit.`
                : "Review the proposed changes below. Nothing is pushed to GitHub until you approve."}
            </p>
          ) : null}
          {followUpOf?.revisionNote ? (
            <p className="mt-3 rounded-xl border border-fog bg-mist px-4 py-3 text-[13px] leading-6 text-carbon whitespace-pre-wrap">
              {followUpOf.revisionNote}
            </p>
          ) : null}
          {canFollowUp && selectedRun ? (
            <form
              className="mt-5 rounded-xl border border-fog bg-mist p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void followUp(selectedRun.id);
              }}
            >
              <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
                Follow up on PR{selectedRun.prNumber ? ` #${selectedRun.prNumber}` : ""}
              </p>
              {pendingFeedback.length ? (
                <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-6 text-carbon">
                  {pendingFeedback.map((item) => (
                    <li key={item.id} className="break-words">
                      {item.url ? (
                        <a href={item.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                          {feedbackEvent(item, null)}
                        </a>
                      ) : (
                        feedbackEvent(item, null)
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <textarea
                value={followUpNote}
                onChange={(event) => setFollowUpNote(event.target.value)}
                placeholder={
                  pendingFeedback.length
                    ? "Anything to add? The feedback above is addressed either way."
                    : "What should change on the pull request? The agent continues on its branch."
                }
                rows={3}
                className="mt-2 w-full resize-none rounded-xl border border-border bg-paper-white px-3 py-2 text-sm tracking-[-0.32px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={followingUp || (!followUpNote.trim() && pendingFeedback.length === 0)}
                  className="rounded-full bg-carbon px-4 py-2 text-[13px] font-medium text-linen disabled:opacity-40"
                >
                  {followingUp ? "Starting…" : "Start follow-up"}
                </button>
                <p className="text-[12px] text-ash">
                  {botsEnabled
                    ? pendingFeedback.length
                      ? "The crew starts on new feedback by itself after a short wait; this starts it now."
                      : autoPush
                        ? "The crew builds it and pushes it when Bibi is done."
                        : "The crew builds it; the result waits here to be pushed."
                    : "Runs like a card you start by hand; the result waits here to be pushed."}
                </p>
              </div>
            </form>
          ) : null}
          {selectedRun?.status === "needs_approval" && selectedRun.warning ? (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-amber/50 bg-amber/10 px-4 py-3 text-[13px] leading-6 text-carbon"
            >
              {selectedRun.warning}
            </p>
          ) : null}
          {selectedRun?.status === "needs_approval" && selectedRun.error ? (
            <p role="alert" className="mt-3 text-[13px] text-ember">
              The last attempt failed: {selectedRun.error}
            </p>
          ) : null}
          {selectedRun?.status === "needs_approval" && !crewActive ? (
            <form
              className="mt-5 rounded-xl border border-fog bg-mist p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void reviseRun(selectedRun.id);
              }}
            >
              <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
                Ask for changes
              </p>
              <textarea
                value={revisionNote}
                onChange={(event) => setRevisionNote(event.target.value)}
                placeholder="What should be different? The agent continues from these changes."
                rows={3}
                className="mt-2 w-full resize-none rounded-xl border border-border bg-paper-white px-3 py-2 text-sm tracking-[-0.32px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={revising || !revisionNote.trim()}
                className="mt-2 rounded-full bg-carbon px-4 py-2 text-[13px] font-medium text-linen disabled:opacity-40"
              >
                {revising ? "Sending…" : "Send back to agent"}
              </button>
            </form>
          ) : null}
          {cardRuns.length > 1 ? <CardHistory runs={cardRuns} currentId={selectedRun?.id ?? null} /> : null}
          {selectedRun ? (
            <div className="mt-6">
              {selectedDetail ? (
                <RunLog
                  key={selectedRun.id}
                  lines={selectedDetail.log}
                  live={selectedRun.status === "running"}
                  defaultOpen={selectedRun.status === "running" || selectedRun.files.length === 0}
                />
              ) : (
                <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
                  Run log <span className="font-mono normal-case text-ash/70">· {selectedRun.logCount} lines · loading…</span>
                </p>
              )}
              {selectedDetail && selectedDetail.proposedWrites.length > 0 ? (
                <>
                  <p className="mt-6 text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
                    Proposed changes
                  </p>
                  <ul className="mt-2 flex flex-col gap-2">
                    {selectedDetail.proposedWrites.map((write) => (
                      <li key={write.path} className="rounded-lg border border-fog bg-mist">
                        <details>
                          <summary className="cursor-pointer p-3">
                            <span className="break-all font-mono text-[12px] text-carbon">{write.path}</span>
                            {write.diff ? <DiffCount diff={write.diff} /> : null}
                            {write.deleted ? (
                              <span className="ml-2 rounded-full bg-ember/15 px-2 py-0.5 font-mono text-[10px] uppercase text-ember">
                                deleted
                              </span>
                            ) : null}
                            <span className="mt-1 block text-[12px] text-ash">{write.message}</span>
                          </summary>
                          <ChangePreview
                            diff={write.diff}
                            content={write.content}
                            deleted={write.deleted}
                          />
                        </details>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {selectedRun.prUrl ? (
                <a
                  href={selectedRun.prUrl}
                  className="mt-4 inline-block text-[13px] text-brand-ink"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open pull request
                </a>
              ) : null}
            </div>
          ) : null}
          </div>
        </section>
      ) : null}

      {terminal ? (
        <BoxTerminal
          target={terminal}
          sessionId={terminal.kind === "shell" ? (shells[terminal.runId ?? "box"] ?? null) : null}
          onSession={(id) => {
            if (terminal.kind !== "shell") return;
            const key = terminal.runId ?? "box";
            setShells((current) => {
              const next = { ...current };
              if (id) next[key] = id;
              else delete next[key];
              return next;
            });
          }}
          onClose={() => setTerminal(null)}
        />
      ) : null}
      {desktopOpen ? <BoxDesktop onClose={() => setDesktopOpen(false)} /> : null}
      <Dialog open={newCardOpen} onOpenChange={setNewCardOpen}>
        <DialogContent
          className="gap-5 rounded-2xl border border-fog bg-paper-white p-5 ring-0 sm:max-w-lg"
        >
          <DialogHeader className="gap-1">
            <DialogTitle className="text-[15px] tracking-[-0.32px] text-carbon">
              New card
            </DialogTitle>
            <DialogDescription className="text-[13px] text-ash">
              Drop a task for the crew to pick up.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createCard();
            }}
          >
            <div className="flex h-11 min-h-11 items-center rounded-full border border-border bg-muted px-4 focus-within:ring-2 focus-within:ring-ring">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title"
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-sm tracking-[-0.32px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="rounded-[22px] border border-border bg-muted px-4 py-3 focus-within:ring-2 focus-within:ring-ring">
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="What should the crew do?"
                rows={4}
                className="w-full resize-none bg-transparent text-sm tracking-[-0.32px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ModelPicker
                models={repoOptions}
                value={repo || undefined}
                onValueChange={setRepo}
                placeholder="Repo"
                emptyIcon={<FolderGit2 className="size-4 text-muted-foreground" />}
                emptyTitle="No repos found"
                emptyHint={
                  connections.some((item) => item.provider === "github")
                    ? "Give the Kru GitHub App access to a repo, then reload."
                    : "Connect GitHub in Settings to list repos."
                }
                searchPlaceholder="Search repos…"
                side="bottom"
                className="min-h-11"
              />
              <ModelPicker
                models={modelOptions}
                value={activeModel || undefined}
                onValueChange={setModel}
                placeholder={hasModelProvider ? "Model" : "Connect a model"}
                emptyHint="Add an API endpoint in Settings."
                side="bottom"
                className="min-h-11"
              />
            </div>
            {error ? (
              <p className="text-[13px] text-ember">{error}</p>
            ) : null}
            <div className="mt-1 flex justify-end">
              <button
                type="submit"
                disabled={busy || !title.trim()}
                className="min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-brand-foreground disabled:opacity-40"
              >
                Drop
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent
          showCloseButton={false}
          className="gap-5 rounded-2xl border border-fog bg-paper-white p-5 ring-0 sm:max-w-sm"
        >
          <DialogHeader className="gap-1">
            <DialogTitle className="text-[15px] tracking-[-0.32px] text-carbon">
              Clear merged
            </DialogTitle>
            <DialogDescription className="text-[13px] text-ash">
              Are you sure you want to clear all merged requests?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmClearOpen(false)}
              className="rounded-full border border-fog bg-paper-white px-4 py-2 text-[13px] font-medium text-carbon"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmClearOpen(false);
                void clearMerged();
              }}
              className="rounded-full bg-ember px-4 py-2 text-[13px] font-medium text-white"
            >
              Clear merged
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <TeamChat
        open={chatOpen}
        onOpenChange={setChatOpen}
        popped={chatPopped}
        onPopOut={popOutChat}
        enabled={botsEnabled}
        onActivity={() => void load()}
        onOpenCard={(cardId) => {
          setChatOpen(false);
          setSelectedId(cardId);
        }}
      />
    </div>
  );
}

/** Long proposed files are truncated in the preview; the pull request has them whole. */
const PREVIEW_LIMIT = 20_000;

/** How long a card must be held before it lifts for dragging. */
const HOLD_MS = 450;
/** Circumference of the hold ring (r = 8). */
const HOLD_RING = 2 * Math.PI * 8;

/** A column stacks its cards once it holds this many. */
const STACK_FROM = 4;
/** How much of each stacked card the next one covers. */
const STACK_OVERLAP = 0.2;

const REMEMBER_KEY = "kru.lastCard";

/** The repo and model of the last card made in this browser, if any. */
function readRemembered(): { repo: string; model: string } {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    const parsed = raw ? (JSON.parse(raw) as { repo?: string; model?: string }) : {};
    return { repo: parsed.repo ?? "", model: parsed.model ?? "" };
  } catch {
    return { repo: "", model: "" };
  }
}

function rememberChoice(repo: string, model: string) {
  try {
    window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ repo, model }));
  } catch {
    /* private mode or storage blocked; nothing to remember */
  }
}

function statusLabel(status: Card["status"]) {
  if (status === "running") return "running";
  if (status === "needs_approval") return "awaiting approval";
  if (status === "approved") return "PR open";
  if (status === "merged") return "merged";
  if (status === "error") return "error";
  return "open";
}

function columnAt(x: number, y: number): ColumnId | null {
  const node = document
    .elementFromPoint(x, y)
    ?.closest("[data-column]");
  const value = node?.getAttribute("data-column");
  if (value === "drop" || value === "run" || value === "review") return value;
  return null;
}

/**
 * A column's card list. Once stacked, each card tucks under the next by a fifth
 * of its height; hovering a card lifts it and pushes the rest down (see
 * `.kru-stack` in globals.css).
 */
function CardStack({
  stacked,
  className,
  children,
}: {
  stacked: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !stacked) return;
    // Cards differ in height, so each one's overlap comes from the card above it.
    const measure = () => {
      let above: HTMLElement | null = null;
      for (const child of Array.from(node.children) as HTMLElement[]) {
        const overlap = above ? Math.round(above.offsetHeight * STACK_OVERLAP) : 0;
        child.style.setProperty("--kru-stack-overlap", `${overlap}px`);
        above = child;
      }
    };
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      for (const child of Array.from(node.children)) sizes.observe(child);
      measure();
    };
    const cards = new MutationObserver(watch);
    cards.observe(node, { childList: true });
    watch();
    return () => {
      cards.disconnect();
      sizes.disconnect();
    };
  }, [stacked]);

  return (
    <div ref={ref} className={cn(className, stacked ? "kru-stack" : "gap-2")}>
      {children}
    </div>
  );
}

function BoardCard({
  card,
  run,
  job,
  selected,
  dimmed,
  lifting,
  holding,
  feedback,
  onSelect,
  onPickup,
  onMove,
  onRelease,
}: {
  card: Card;
  run?: RunSummary;
  /** The crew's newest job on this card, if it ever had one. */
  job?: BotJob;
  selected: boolean;
  dimmed?: boolean;
  lifting?: boolean;
  /** Pressed and waiting for the hold to complete; shows the filling ring. */
  holding?: boolean;
  /** Feedback on the card's pull request that no follow-up has taken yet. */
  feedback?: number;
  onSelect?: () => void;
  onPickup?: (event: PointerEvent<HTMLElement>) => void;
  onMove?: (event: PointerEvent<HTMLElement>) => void;
  onRelease?: (event: PointerEvent<HTMLElement>) => void;
}) {
  // Working while the agent runs, while the crew has it, and again while an
  // approved run opens its pull request.
  const crew = job && isActiveStage(job.stage) ? botForStage(job.stage) : null;
  const live = card.status === "running" || run?.status === "applying" || Boolean(crew);
  const lastLog = logHeadline(run?.lastLog ?? undefined);
  // The agent stopped before saying it was done; the reviewer should look closely.
  const unfinished = card.status === "needs_approval" && Boolean(run?.warning);
  // What a finished run produced, so Review can be triaged from the board.
  const result =
    !live && run && run.files.length > 0 && card.column === "review"
      ? run.files.reduce(
          (acc, file) => ({ files: acc.files + 1, added: acc.added + file.added, removed: acc.removed + file.removed }),
          { files: 0, added: 0, removed: 0 },
        )
      : null;
  const summary = run?.summary?.split("\n")[0];

  return (
    <article
      onPointerDown={onPickup}
      onPointerMove={onMove}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onClick={() => {
        if (!onPickup) onSelect?.();
      }}
      className={cn(
        "relative select-none rounded-xl border p-3.5 text-left",
        lifting ? "cursor-grabbing shadow-subtle-3" : "cursor-pointer",
        selected || lifting ? "border-brand bg-mist" : "border-fog bg-linen",
        live && "border-brand/60 bg-mist",
        dimmed && "opacity-25",
      )}
    >
      {holding ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="pointer-events-none absolute -right-1.5 -top-1.5 size-5 -rotate-90 rounded-full bg-paper-white text-brand-ink"
        >
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="kru-hold-ring"
            style={{
              strokeDasharray: HOLD_RING,
              strokeDashoffset: HOLD_RING,
              animationDuration: `${HOLD_MS}ms`,
            }}
          />
        </svg>
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <p className="text-[14px] font-medium tracking-[-0.32px] text-carbon">
          {card.title}
        </p>
        {live ? null : card.status === "merged" ? (
          <GitMerge
            role="img"
            aria-label="merged"
            className="size-4 shrink-0 text-grape"
          />
        ) : (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[-0.32px]",
              card.status === "error"
                ? "bg-ember/15 text-ember"
                : unfinished
                  ? "bg-amber/20 text-carbon"
                : card.status === "approved"
                  ? "bg-sky/15 text-sky"
                  : "bg-mist text-ash",
            )}
          >
            {unfinished ? "check work" : statusLabel(card.status)}
          </span>
        )}
      </div>
      {live ? (
        <div className="mt-3 flex flex-col gap-2">
          {crew ? <BotBadge bot={crew} label={`${crew.name} ${crew.verb}`} className="w-fit" /> : null}
          <RunStatus label={lastLog ?? "Working"} />
        </div>
      ) : (
        <>
          {result ? (
            <p className="mt-2 font-mono text-[11px] text-carbon">
              {result.files} file{result.files === 1 ? "" : "s"} ·{" "}
              <span className="text-mint">+{result.added}</span>{" "}
              <span className="text-ember">−{result.removed}</span>
            </p>
          ) : null}
          {result && summary ? (
            <p className="mt-1 truncate text-[12px] text-graphite">{summary}</p>
          ) : null}
          {feedback ? (
            <p className="mt-1 text-[12px] text-sky">
              {feedback} new on the PR
            </p>
          ) : null}
          <p className="mt-2 truncate text-[12px] text-ash">
            {card.repo?.split("/")[1] ?? "No repo"}
            {card.issueNumber ? ` #${card.issueNumber}` : ""} ·{" "}
            {modelLabel(card.model)}
          </p>
        </>
      )}
    </article>
  );
}

const RUN_STATUS_LABEL: Record<Run["status"], string> = {
  running: "running",
  needs_approval: "waiting",
  applying: "pushing",
  approved: "approved",
  merged: "merged",
  error: "failed",
  cancelled: "superseded",
};

function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Every run a card has had, newest first: why each one started (the task, a
 * reviewer's note, feedback on the pull request), what Lulu said about it,
 * and how it ended. A run the next round replaced reads "superseded".
 */
function CardHistory({ runs, currentId }: { runs: RunSummary[]; currentId: string | null }) {
  return (
    <details className="mt-6 rounded-xl border border-fog">
      <summary className="cursor-pointer px-4 py-3 text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
        History · {runs.length} runs
      </summary>
      <ol className="flex flex-col divide-y divide-fog border-t border-fog">
        {runs.map((run, index) => {
          const reviews = run.reviews;
          const pushed = run.pushedLine;
          const why = run.followUpReason
            ? `Follow-up (${run.followUpReason === "check" ? "CI failed" : run.followUpReason === "review" ? "review feedback" : "asked by hand"})`
            : run.revisionNote
              ? "Sent back"
              : "Started";
          return (
            <li key={run.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-mono text-ash">#{runs.length - index}</span>
                <span className="text-carbon">{why}</span>
                {run.bot ? <span className="text-ash">· {getBot(run.bot).name}</span> : null}
                <span className="text-ash">· {when(run.createdAt)}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase",
                    run.status === "error" ? "bg-ember/15 text-ember" : run.status === "approved" || run.status === "merged" ? "bg-sky/15 text-sky" : "bg-mist text-ash",
                  )}
                >
                  {RUN_STATUS_LABEL[run.status]}
                </span>
                {run.id === currentId ? <span className="text-[11px] text-ash">current</span> : null}
              </div>
              {run.revisionNote ? (
                <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-[12px] leading-5 text-graphite">{run.revisionNote}</p>
              ) : null}
              {reviews.map((review, i) => (
                <p key={i} className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-carbon">
                  <span className="font-medium">Lulu: {review.verdict === "pass" ? "passed" : "changes needed"}</span>
                  {review.notes ? ` — ${review.notes}` : ""}
                </p>
              ))}
              {run.error && run.status === "error" ? <p className="mt-1.5 break-words text-[12px] text-ember">{run.error}</p> : null}
              {pushed ? <p className="mt-1.5 break-all font-mono text-[11px] text-ash">{pushed}</p> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function DiffCount({ diff }: { diff: string }) {
  const { added, removed } = diffStats(diff);
  return (
    <span className="ml-2 font-mono text-[11px]">
      <span className="text-mint">+{added}</span> <span className="text-ember">−{removed}</span>
    </span>
  );
}

/**
 * The reviewable change for one file: its unified diff when the run
 * produced one, otherwise the whole new content (older runs).
 */
function ChangePreview({
  diff,
  content,
  deleted,
}: {
  diff?: string;
  content: string;
  deleted?: boolean;
}) {
  if (!diff) {
    return (
      <pre className="max-h-80 overflow-auto border-t border-fog p-3 font-mono text-[11px] leading-5 whitespace-pre text-graphite">
        {deleted
          ? "This file is removed."
          : content.length > PREVIEW_LIMIT
            ? `${content.slice(0, PREVIEW_LIMIT)}\n\n… ${content.length - PREVIEW_LIMIT} more characters`
            : content}
      </pre>
    );
  }
  const rows = diffRows(diff);
  const lastLine = rows.reduce(
    (max, row) => ("oldLine" in row || "newLine" in row ? Math.max(max, row.oldLine ?? 0, row.newLine ?? 0) : max),
    0,
  );
  // Both number columns share one width, sized to the longest number.
  const gutter = { width: `calc(${String(lastLine).length}ch + 1.25rem)` };
  return (
    <div className="max-h-96 overflow-auto border-t border-fog font-mono text-[11px] leading-5">
      <div className="w-max min-w-full">
        {rows.map((row, index) => {
          if (row.kind === "hunk" || row.kind === "note") {
            return (
              <div
                key={index}
                className={cn(
                  "flex whitespace-pre",
                  row.kind === "hunk" ? "bg-sky/10 text-sky" : "text-ash italic",
                )}
              >
                <span className="shrink-0 select-none" style={gutter} aria-hidden />
                <span className="shrink-0 select-none" style={gutter} aria-hidden />
                <span className="px-3">{row.text}</span>
              </div>
            );
          }
          return (
            <div
              key={index}
              className={cn(
                "flex whitespace-pre",
                row.kind === "add" && "bg-mint/10",
                row.kind === "del" && "bg-ember/10",
              )}
            >
              <DiffLineNumber value={row.oldLine} kind={row.kind} style={gutter} />
              <DiffLineNumber value={row.newLine} kind={row.kind} style={gutter} />
              <span
                className={cn(
                  "w-5 shrink-0 select-none text-center",
                  row.kind === "add" && "text-mint",
                  row.kind === "del" && "text-ember",
                )}
                aria-hidden
              >
                {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
              </span>
              <span className={cn("pr-3", row.kind === "context" ? "text-graphite" : "text-carbon")}>
                {row.text || " "}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffLineNumber({
  value,
  kind,
  style,
}: {
  value?: number;
  kind: "add" | "del" | "context";
  style: CSSProperties;
}) {
  return (
    <span
      className={cn(
        "shrink-0 select-none px-2 text-right text-ash/70",
        kind === "add" && "bg-mint/15 text-mint/80",
        kind === "del" && "bg-ember/15 text-ember/80",
      )}
      style={style}
    >
      {value ?? ""}
    </span>
  );
}

// An icon-only card action; the label shows as a tooltip and names the button.
function IconAction({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={label}
            onClick={onClick}
            className={cn(
              "size-9 rounded-full border-fog bg-transparent text-carbon hover:border-brand hover:bg-transparent hover:text-carbon",
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
