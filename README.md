# Kru

[![Docker image](https://github.com/dawsja/kruagent/actions/workflows/docker.yml/badge.svg)](https://github.com/dawsja/kruagent/actions/workflows/docker.yml)

Kru is a self-hosted Kanban board for AI coding agents. You drop a card
describing a change, an agent clones your GitHub repo into its own container,
works until the change builds and tests pass, and nothing reaches GitHub until
you approve. Approving opens a pull request.

It runs as two containers for one person, the server and the box, with a
local SQLite database and your own API keys or subscriptions. There is no hosted service and nothing to sign up for.

## How it works

1. **Drop** a card with a task, a repo, and a model.
2. **Run** it. The agent gets a fresh clone in the box (see below) with a
   shell, edits files, runs the project's own build and tests, and fixes what
   breaks until it says it's done.
3. **Review** the diff on the card. Approve to open a pull request from a
   new `kru/…` branch, discard it, or **ask for changes**: write what should
   be different and the agent continues in the same workspace from those
   changes, so a nearly right result doesn't start over.

### The box

Agents never run on the Kru server itself. `docker-compose.yml` starts a
second container, the **box**, built from [`box/`](box/): Node 24, Bun, git,
Python 3, a C toolchain and a GNOME desktop. For each run, the box clones the repo into a
throwaway workspace, runs the agent's commands there as an unprivileged user
with time and output limits, and deletes the workspace when the run ends.
Kru talks to it over the Compose network with a token the box generates on
first start; no port is published and nothing inside the box can read Kru's
database or keys. The GitHub token is used for the clone only and is not
stored in the workspace.

A browser is installed too, as `google-chrome` with `CHROME_BIN` pointing at
it: Google Chrome on amd64, and Debian's Chromium on arm64, where Google
publishes no build. Chrome's sandbox cannot start in the box: Docker's
seccomp profile denies the user namespaces it asks for, and
`no-new-privileges` disables its setuid helper. So `google-chrome` is a
wrapper that adds `--no-sandbox` — the container and its unprivileged user
are the isolation — and the desktop's Chrome launcher uses it too. The
wrapper also skips Chrome's first-run dialog, and a policy file turns off
metrics, welcome tabs, sign-in and sync, so a fresh box opens straight to a
page.

Repos that need more tooling: edit `box/Dockerfile`, uncomment `build: ./box`
in `docker-compose.yml`, and run `docker compose up -d --build`.

The box is yours too. The terminal icon in the board header opens a shell
in it. The monitor icon opens a small Linux desktop: a GNOME session
(GNOME Flashback, which needs no 3D acceleration) with a terminal, a file
manager and a text editor, shown in the browser with full mouse and
keyboard control. It starts the first time
you open it, keeps running while hidden, and stops after two hours with
nobody looking or when you click **Stop desktop**. Each run's clone lives in
`~/workspace` while it works, so a terminal on the desktop can follow along.
Nothing reaches the box directly: the VNC connection is bound to loopback
inside the box and bridged through Kru, so the same login and no extra
ports apply. The clipboard works both ways: Ctrl+V (or Ctrl+Shift+V in a
terminal, or Shift+Insert) pastes what you copied on your machine, and text
copied in the desktop lands on your clipboard; a browser that wants a click
first gets the next one you make in the desktop. In the box terminal,
Ctrl+Shift+C or Ctrl+C with a selection copies, and Ctrl+V pastes. The
wallpaper is `box/wallpaper.png`; replace it to use your own.

On a running card, **Watch agent** shows what the agent is doing live: every
command with its output, and the files it reads and writes. **Shell in
workspace** drops you into that run's clone alongside the agent, and stays
available while the card waits for review, so you can run the failing test
yourself before deciding. The desktop and terminals run as the same
unprivileged user as the agent; terminals close when you leave, and
`~/workspace` is wiped when the box restarts.

A finished run keeps its workspace, so **ask for changes** continues in the
clone the reviewed result was built in: no second clone, no reinstall, and
the build cache is still warm. The changes themselves are held in Kru's
database either way, so nothing is lost when the workspace has gone — the
revision just clones and puts them back. Three cards keep a workspace at a
time, for a day each (`KRU_REVIEW_WORKSPACES`, `0` to keep none).

Every run starts from a fresh clone, so package installs happen each time.
They're fast because bun, npm, pnpm, yarn, pip and uv all cache under
`~/.cache` in the box, which lives on the `kru-box-cache` volume. To start
over, stop the box and run `docker volume rm kru_kru-box-cache` (the prefix
is your Compose project name).

## Bots

Kru can run the board for you. Turn on **automated bots** in the last step
of setup, or later under Settings → Bots, and a crew of five picks up every
card you drop:

| Bot | Job |
|---|---|
| **Pip** | Coordinates: picks up cards, answers you in the Team chat, creates cards when asked |
| **Momo** | Builds the change in a fresh clone, like a run you start by hand |
| **Kiko** | Runs the repo's own `lint`, `test` and `build` scripts in that workspace and reports |
| **Lulu** | Reviews the change with the workspace in hand (reads around it, runs what covers it) and Kiko's report; sends it back to Momo with notes, or passes it |
| **Bibi** | Writes the summary and the commit message, then hands the card to you |

A card in Run shows who has it ("Momo building"); it lands in Review when
the crew is done, and you approve the pull request as usual. Lulu sends a
card back at most twice (`KRU_BOT_REVIEW_ROUNDS`); after that it comes to
you with her concerns as a warning. The crew works one card at a time
(`KRU_BOT_CONCURRENCY`). Card work uses each card's model, so a Claude Code
card is built and reviewed by Claude Code.

Lulu reviews in the run's workspace when the box still has it: she can open
the files around the change, grep for other callers and run the test that
covers it, a dozen steps at most, instead of judging the diff alone. Her
tools are for looking. On Claude Code the file-writing tools are taken
away, and either way Kru compares the workspace before and after and puts
it back exactly as Momo left it if anything moved. Without the workspace she
reviews from the diff, as before.

When the crew fails on the work itself (the agent errors, the box drops a
run, a stage crashes), it tries the card once more two minutes later
(`KRU_BOT_RETRIES`, `0` to never retry). It doesn't retry what only you can
fix, like a missing repo, model or sign-in, or a card you moved on in the
meantime; a failure after the change was built still hands you the change
with a warning, as before.

**Repo instructions** are standing rules for a repo ("use pnpm", "never touch
migrations/"): tell Pip "in owner/repo, always run the linter with --fix" and
Momo gets them with every card's task there and Lulu reviews against them.
Kru's own runner also quotes the repo's `AGENTS.md` or `CLAUDE.md`; Claude
Code reads those itself.

A card's **History** lists every run it has had, newest first: why each
started (the task, a note sent back, feedback on its pull request), what
Lulu said about it, and how it ended.

The **Team chat** (the speech-bubble icon in the board header) is one room
for you and the crew. Mention a bot to address it, or just talk and Pip
answers: "@pip create a card to add dark mode to owner/repo", "@kiko run
`ls ~` on the box", "@momo work on the failing card". Bots hand off to each
other in the same room, a few hops at most. A dot on the icon, in the
color of the bot that spoke last, means something new since you last had
the room open. While the board is in the background, Pip also sends a
browser notification when a card moves ("Kiko is running checks on …",
"… is ready for review"); your browser asks the first time you open the
chat. To approve from the room, say so: "make the PR for the theme toggle
one" or "open the PR for the orange accent card". Kru itself, not a bot's
model, matches your words loosely against the titles, descriptions and
summaries of cards waiting in Review, then runs the same approve as the
button on the card, and Pip posts the pull request link. If the words fit
more than one card, Pip lists them and you answer with the number.

Asking for changes works the same way: name the card loosely and say what
should be different, as in "on the landing page one, make the hero smaller"
or "revise the blur fix, it's too dark now". Kru matches the words against
the cards waiting in Review and does what the "Ask for changes" box on the
card does: the rest of your message is the note, the card goes back to Run,
and the agent continues from its changes in the same workspace. When more
than one card fits, Pip asks which; when the card you named is still in
Drop, still being worked on, or already has a pull request, Pip says so
instead of trying.

### After the pull request

The crew keeps a pull request it opened until it merges. Kru follows every
open one from the server, with or without a browser tab: whether it was
merged or closed, and what people and CI said about it. Reviews, comments
on the diff, comments in the conversation and check runs that failed on
the commit Kru pushed are read every half minute (conditionally, so a
quiet pull request costs nothing against GitHub's rate limit), and each one
is a line from Pip in the Team chat. A merge marks the card; a pull request
closed without merging puts the card in error with a **Reopen PR** button.
**Clear merged** in the Review column's header deletes the merged cards.

When the feedback asks for a change (a review requesting changes, a
comment, a failing check; "LGTM" doesn't count), the crew starts a
**follow-up**: a run that clones the pull request's own branch, so what it
proposes is exactly what it adds, then goes through Kiko, Lulu and Bibi as
usual. It waits about a minute and a half after the last comment so a
reviewer's five comments become one run, and new feedback that arrives
while a follow-up is waiting in Review is folded into it. The card lands in
Review with **Approve and push to PR #N**; approving pushes one more commit
to the same branch, no new pull request, and Kru leaves a comment on the
pull request saying whose feedback it addressed. From the card you can
also start a follow-up yourself with a note, and in the room "@pip on the
dark mode PR, also rename the flag" does the same. A failing check may
start at most three follow-ups on one pull request
(`KRU_PR_CHECK_FOLLOWUPS`); a person's review never runs out.

**Auto-push** (Settings → Bots, or "@pip turn on auto push") pushes a
follow-up as soon as Bibi is done, without a click. It is off by default,
and it only ever applies to follow-ups on pull requests you already
approved; a new pull request always waits for you.

### Issues as cards

GitHub issues can be the crew's work too. Turn on **Pick up labelled
issues** under Settings → Bots, and every minute Kru asks the repo you chose
at setup, and every repo a card uses, for open issues carrying the label
(`kru` unless you change it there, or say "@pip pick up issues labelled
bug"). Each new one becomes a card in Drop with the issue's title and text
and a link back, and the crew picks it up like any other. Its pull request
says `Closes #N`, so merging closes the issue, and Kru comments on the issue
with the pull request's link when it opens. An issue becomes a card once:
deleting the card doesn't bring it back. Without the switch, "@pip grab
issue 42 from owner/repo" imports one issue on its own, label or not.

### GitHub App permissions

Reading check runs needs **Checks: Read-only**, and issues need **Issues:
Read and write** (read to find them, write to comment on them). Apps
created by Kru now ask for both. An app created before this needs them
added by hand: open the app's permissions page on GitHub, add them, save,
then accept the new permissions on the installation. Until then the rest
keeps working, and Settings → Bots says what's missing and links both
pages.

Each bot's personality is a
Markdown file under [`bots/`](bots/); edit a `SOUL.md` to change how one
behaves.

The crew chats with the model picked under Settings → Bots: an API endpoint
or subscription through the AI SDK, or **Claude Code**. With Claude Code,
each bot keeps one `claude` session in the box across turns (resumed by
session id, closed after ten idle minutes, `BOT_IDLE_MS` on the box) and
reaches Kru's card and chat tools through a small MCP bridge the box
mounts into it; Kru runs the tools and answers, so the CLI never talks to
anything but that bridge. Left unset, the crew uses the first endpoint, or
Claude Code when nothing else is connected and the CLI is signed in.

The bots have the box: from chat they can run commands and read or write
files anywhere under the agent user's home, and keep their own notes under
`~/bots`. They still can't reach GitHub themselves; nothing is pushed until
you approve, or, for a follow-up, until you turn on auto-push. A card you
move back to Drop by hand is left alone until you ask a bot to run it.

## Requirements

- A GitHub account (personal or organization) where Kru can create a private
  GitHub App.
- A model: a ChatGPT (Plus, Pro, Business, Enterprise) or SuperGrok / X
  Premium subscription to sign in with, a Claude plan to use through Claude
  Code in the box, or an API key for an endpoint:
  OpenAI, Anthropic, xAI, OpenRouter, DeepSeek, Groq, MiniMax, Ollama, or any
  OpenAI- or Anthropic-compatible server.
- Docker, or Node.js 22.13 or newer with [Bun](https://bun.sh) for installing
  dependencies.

## Quick start with Docker

Two images are published to GitHub Container Registry for `linux/amd64`
and `linux/arm64`: `ghcr.io/dawsja/kruagent` (the server) and
`ghcr.io/dawsja/kruagent-box` (where agents work). You don't need to clone
the repo:

```bash
mkdir kru && cd kru
curl -fsSLO https://raw.githubusercontent.com/dawsja/kruagent/main/docker-compose.yml
docker compose up -d
docker compose logs kru | grep "setup token"
```

Or without Compose, on a shared network with a token you choose:

```bash
docker network create kru
docker run -d --name kru-box --restart unless-stopped --network kru \
  --security-opt no-new-privileges:true --pids-limit 2048 --memory 4g \
  -e BOX_TOKEN=change-me -v kru-box-cache:/home/agent/.cache \
  ghcr.io/dawsja/kruagent-box:latest
docker run -d --name kru --restart unless-stopped --network kru \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:1455:3000 \
  -e APP_URL=http://localhost:3000 \
  -e KRU_BOX_URL=http://kru-box:8787 -e KRU_BOX_TOKEN=change-me \
  -v kru-data:/data \
  ghcr.io/dawsja/kruagent:latest
docker logs kru | grep "setup token"
```

Open http://localhost:3000/register, paste the setup token, and create your
account. Kru listens on `127.0.0.1` only; see [HTTPS and remote
access](#https-and-remote-access) to reach it from elsewhere.

Image tags: `latest` follows `main`, `1.2.3` and `1.2` come from release
tags, and `sha-<commit>` pins an exact build. To build the images yourself,
clone the repo and uncomment `build: .` and `build: ./box` in
`docker-compose.yml`.

Data lives in the `kru-data` volume. The container runs as the `node` user
(uid 1000); if you replace the volume with a host folder, run
`sudo chown 1000:1000` on that folder first.

## Quick start without Docker

```bash
git clone https://github.com/dawsja/kruagent.git kru
cd kru
bun install
cp .env.example .env.local   # set APP_URL if you won't use http://localhost:3000
bun run build
bun run start
```

The setup token is printed in the terminal when Kru starts. Open
http://localhost:3000/register.

Agents need the box, so run its image with Docker and point Kru at it in
`.env.local`:

```bash
docker run -d --name kru-box --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -e BOX_TOKEN=change-me \
  -v kru-box-cache:/home/agent/.cache \
  ghcr.io/dawsja/kruagent-box:latest
# .env.local
KRU_BOX_URL=http://127.0.0.1:8787
KRU_BOX_TOKEN=change-me
```

## First run

1. **Create your account** at `/register` with the setup token. Kru has
   exactly one account; registration closes once it exists.
2. **Connect a model.** Sign in with a ChatGPT or SuperGrok subscription
   (see [Subscriptions](#subscriptions)), or pick a provider and paste an API
   key; Kru lists the models it offers. You can add several connections,
   including more than one endpoint on the same API format.
3. **Create your GitHub App.** One button, one trip through GitHub, in the
   tab you are already in. Kru sends you over with a prefilled manifest;
   rename the app if you like and create it under your account, then choose
   the repos Kru may read and open pull requests on — all of them, or just
   some — and authorize it. The app is private and belongs to you, and Kru
   asks only for contents, pull request and issue write access and read
   access to checks. You land back in setup where you left it.
4. **Open the board.** New cards start on your most recently pushed repo;
   pick a different one in the board's repo picker.

`APP_URL` must match the address in your browser before you create the
GitHub App, because GitHub stores the callback URLs from it. Opening Kru at
`127.0.0.1` or `0.0.0.0` instead of `localhost` sends you to the `APP_URL`
host, so login cookies stay on one address.

## Subscriptions

If you already pay for ChatGPT or SuperGrok, you can sign in with that plan
instead of an API key. Runs then count against the plan and its limits.

| Plan | How | Notes |
|---|---|---|
| ChatGPT Plus, Pro, Business, Enterprise | **Sign in with ChatGPT** in Settings | Opens OpenAI's sign-in in a new tab; Kru identifies itself as `kru` |
| SuperGrok, X Premium | **Sign in with X** in Settings | A short code to enter at auth.x.ai; xAI decides which plans qualify |
| Claude Pro / Max | The **Claude Code** engine on a card | Runs Anthropic's own `claude` CLI in the box; see [Claude Code](#claude-code). Anthropic's terms (February 2026) forbid a Claude subscription sign-in inside third-party tools, so there is none in Settings. |

This is your own plan on your own Kru: personal use, one account per
install, under the provider's terms. A provider can change or withdraw
subscription access for third-party tools at any time; when that happens the
sign-in simply stops working and an API key still does.

### Claude Code

A card can run on the Claude Code CLI instead of a model connection: once
the CLI is signed in, its models appear in the model picker under **Claude
Code**, like a subscription's would. The box image ships the `claude` binary
as published, and it runs in the card's workspace with its own tools; Kru
still clones the repo, collects the working tree and holds it for your
review, so approving and pull requests are the same as for any other card.

Sign in once: open the box desktop (the monitor icon on the board, or
**Open box desktop** on the Claude Code card in Settings), run `claude` in a
terminal and follow Anthropic's sign-in. The login is saved on the
`kru-box-claude` volume, so it survives restarts and image updates. Kru never
sees the credentials and does nothing with them; the check in Settings only
asks the CLI whether it can answer. Usage bills to your own Anthropic plan.
To sign out, run `claude /logout` in the same terminal.

**How the ChatGPT sign-in returns to Kru.** OpenAI sends the browser back to
`http://localhost:1455/auth/callback`, an address it fixed for every
third-party tool, so Kru answers on port 1455 of the machine your browser is
on. Docker Compose publishes that port (`127.0.0.1:1455:3000`); without
Docker, Kru listens on it itself. If port 1455 is taken (Codex CLI uses it
during its own login) or Kru runs on another machine, choose **Use a code
instead** (allow it first under ChatGPT → Settings → Security → *Allow device
code login*) or paste the address the browser ended on. The X sign-in always
uses a code.

## Model endpoints

| Format | Examples | Notes |
|---|---|---|
| OpenAI-compatible | OpenAI, OpenRouter, DeepSeek, Groq, Ollama, vLLM | Uses the Responses API on api.openai.com, chat completions elsewhere |
| Anthropic-compatible | Anthropic, MiniMax, gateways | Paste the base URL with or without `/v1` |
| xAI | api.x.ai | Grok models on your API key |

Kru checks the key against the endpoint's model list when you save it. It
never follows redirects when talking to an endpoint, so a key can't be carried
to another server.

**Ollama with Docker:** inside the container, `localhost` is the container.
Uncomment the `extra_hosts` line in `docker-compose.yml` and use
`http://host.docker.internal:11434/v1` as the endpoint URL.

## Configuration

All settings are optional except `APP_URL` when you don't use
`http://localhost:3000`. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | Address you open Kru at |
| `KRU_DATA_DIR` | `./data` (`/data` in Docker) | Database and secret key |
| `KRU_SECRET_KEY` | generated `secret.key` | Encrypts tokens and API keys |
| `KRU_SETUP_TOKEN` | random, printed in logs | Registers the account |
| `BETTER_AUTH_SECRET` | derived from the secret key | Signs login sessions |
| `KRU_DEV_ORIGINS` | none | Extra origins for `bun run dev` |
| `KRU_OAUTH_CALLBACK_PORT` | `1455` | Where the ChatGPT sign-in returns outside Docker; `0` turns the listener off |
| `KRU_CODEX_FORCE_STREAM` | `1` | ChatGPT sign-ins stream from the Codex backend; `0` sends plain requests |
| `KRU_BOX_URL` | `http://box:8787` in Compose | The box agents work in; required |
| `KRU_BOX_TOKEN` | read from the box's state volume | Shared secret, same as `BOX_TOKEN` on the box |
| `KRU_BOX_STATE_DIR` | `/box-state` | Where the box's state volume is mounted, for the token file |
| `KRU_BOX_MEMORY`, `KRU_BOX_CPUS`, `KRU_BOX_SHM` | `4g`, `2`, `256m` | Resource limits for the box (Compose only) |
| `KRU_REVIEW_WORKSPACES` | `3` | How many cards waiting for review keep their workspace, so **ask for changes** continues in it; `0` clones again every time |
| `KRU_BOT_CONCURRENCY` | `1` | How many cards the crew works at once |
| `KRU_BOT_REVIEW_ROUNDS` | `2` | How many times Lulu may send a card back to Momo before passing it on with a warning |
| `KRU_PR_CHECK_FOLLOWUPS` | `3` | How many follow-ups a failing CI check may start on one pull request; a review from a person is never limited |
| `KRU_BOT_RETRIES` | `1` | How many times the crew tries a card again after it failed on the work, two minutes apart |
| `KRU_BOT_EFFORT` | CLI default | `low`, `medium` or `high`: how hard Claude Code thinks per reply when it is the crew's chat model |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | Use an existing GitHub App (all four) |

## Security model

- **One account.** Only whoever can read the server logs, or knows
  `KRU_SETUP_TOKEN`, can register. A database trigger prevents a second
  account.
- **Every page and API route requires a session.** State-changing requests
  must come from Kru's own origin.
- **You approve every change.** Runs stop with the agent's changed files.
  Nothing is pushed until you click Approve. The one exception is yours to
  turn on: with auto-push (Settings → Bots), the crew pushes follow-up
  commits to pull requests you already approved, and never anything else.
- **Agents are boxed.** Commands run in the box container as an unprivileged
  user, in a workspace that is deleted after the run, with process, memory
  and time limits. The box has no access to Kru's data volume, and only Kru
  can reach its API.
- **Secrets are encrypted at rest** with AES-256-GCM: GitHub tokens, the GitHub
  App's client secret, your API keys, and subscription sign-in tokens. The
  database and key files are readable only by the user running Kru.
- **Local by default.** `bun run start` and the Docker port mapping bind to
  `127.0.0.1`.

What this does not protect against: anyone who can read both the database and
`secret.key` can decrypt the stored secrets. Keep them on the same machine only
if you trust it; for more separation, set `KRU_SECRET_KEY` from a secret
manager and don't store it next to the data. Endpoints on your local network
are allowed on purpose, so Ollama and other local servers work. The box has
normal outbound internet access so agents can install dependencies; a model
that runs a malicious command can use that access, so review what a run did
in its log before approving.

## HTTPS and remote access

Put Kru behind a reverse proxy that terminates HTTPS, and set `APP_URL` to the
public `https://` address. Login cookies become `Secure` automatically. With
[Caddy](https://caddyserver.com):

```
kru.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

The board and the Team chat update live over a server-sent event stream,
`/api/events`, so the proxy must pass responses through as they are
written. Caddy does by default. With nginx, Kru's `X-Accel-Buffering: no`
header turns buffering off for that route; other proxies may need
buffering disabled for it. If the stream can't get through, the page falls
back to polling every couple of seconds, so it still works, just less
instantly.

Register your account before exposing Kru, or set `KRU_SETUP_TOKEN` to a long
random value.

A ChatGPT sign-in can't return to a remote Kru on its own (it comes back to
`localhost:1455` on the machine running the browser). Use **Use a code
instead** or paste the callback address; see [Subscriptions](#subscriptions).

## Backups

Everything lives in the data folder: `kru.db` (plus `-wal` and `-shm` files
while running) and `secret.key` unless you use `KRU_SECRET_KEY`. Back up the
whole folder while Kru is stopped, or copy the database live with
`sqlite3 kru.db ".backup kru-backup.db"` and back up the key separately.
Run one Kru process per data folder.

## Reset your password

This removes the account but keeps cards, runs, connections, and API keys.
Restart Kru afterwards and register again with the new setup token.

```bash
node scripts/reset-account.mjs                          # bare metal
docker compose exec kru node scripts/reset-account.mjs  # Docker Compose
docker exec kru node scripts/reset-account.mjs          # docker run
```

## Upgrading

```bash
docker compose pull && docker compose up -d                 # Docker
git pull && bun install && bun run build && bun run start   # bare metal
```

Database migrations run automatically on start. A data folder from older
versions that used `data/kru.json` is imported once and the file is renamed
to `kru.json.imported`; delete it afterwards, since it holds plaintext secrets.

## Development

```bash
bun install
bun run dev      # http://localhost:3000, listening on 127.0.0.1
bun run test     # Node test runner
bun run lint     # ESLint, plus a check that every API route requires a session
docker build -t kru-box box && docker run --rm -p 127.0.0.1:8787:8787 -e BOX_TOKEN=dev kru-box
```

With the box running like that, put `KRU_BOX_URL=http://127.0.0.1:8787` and
`KRU_BOX_TOKEN=dev` in `.env.local` and `bun run dev` uses it.

## AI Disclaimer

AI was used to write a lot of the backend Box logic and the custom claude code driver.
All tests were created by AI as well.
Frontend was mostly provided by shadcn skills and blocks with lucide react icons.

## License

The code is [MIT](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The Kru logo and icons (`public/logo.png`, `app/icon.png` and
`app/favicon.ico`) are licensed artwork and are **not** covered by the MIT license. They're included so Kru
looks right when you run it. Replace them before you publish a fork or build a
derivative project.
