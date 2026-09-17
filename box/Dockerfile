# syntax=docker/dockerfile:1

# The Kru box: where agents clone repos and run commands, and a small Linux
# desktop for the person. The full (not slim) Node image brings git, Python 3
# and a C toolchain; Bun, ripgrep and a browser are added. Extend this file
# if your repos need more tooling.
FROM oven/bun:1.4.2 AS bun

FROM node:24-bookworm
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ripgrep jq \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1001 --user-group agent \
 && mkdir -p /home/agent/workspace /home/agent/.cache /home/agent/.claude /state \
 && chown agent:agent /home/agent/workspace /home/agent/.cache /home/agent/.claude

# Claude Code, as published and unmodified. Cards on the "Claude Code"
# engine run it here; the person signs in to it once from the box desktop
# and the login stays in /home/agent/.claude (a volume). Kru never sees it.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# The desktop: GNOME Flashback (GNOME's session for machines without 3D
# acceleration) on a TigerVNC X server, reached through the Kru UI. It only
# starts when someone opens it and needs no ports: the VNC socket is bound
# to loopback and bridged by server.mjs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server xfonts-base dbus-x11 \
      gnome-session-flashback gnome-flashback gnome-panel metacity \
      gnome-settings-daemon gnome-terminal nautilus gnome-text-editor \
      adwaita-icon-theme fonts-dejavu-core fonts-cantarell dconf-cli \
 && rm -rf /var/lib/apt/lists/*

# A browser, for repos whose tests drive one and for the desktop. Google
# builds Chrome for amd64 only, so arm64 gets Debian's Chromium; both answer
# to `google-chrome`, and the packages bring the fonts and libraries a
# headless browser needs. Either one adds a few hundred MB to the image.
ARG TARGETARCH
RUN set -eux; \
    if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg; \
      echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends chromium; \
      ln -sf /usr/bin/chromium /usr/bin/google-chrome; \
      ln -sf /usr/bin/chromium /usr/bin/google-chrome-stable; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Chrome's sandbox cannot start in the box: Docker's seccomp profile denies
# the user namespaces it asks for, and no-new-privileges disables its setuid
# helper, so Chrome dies before it draws a window. The container and its
# unprivileged user are the isolation here, so a wrapper passes --no-sandbox
# for every way Chrome gets launched: the desktop menu, CHROME_BIN and the
# `google-chrome` on PATH. The profile lives in the container, so every
# restart would be a first run again; the wrapper skips that dialog and the
# default-browser prompt, and a policy file turns off what flags don't reach
# (metrics, welcome tabs, sign-in, sync, the save-password bar, and the
# infobar warning about --no-sandbox, which is expected here). Chrome and
# Chromium read policies from different directories; both get the file.
COPY chrome-policy.json /etc/opt/chrome/policies/managed/kru.json
COPY chrome-policy.json /etc/chromium/policies/managed/kru.json
RUN set -eux; \
    printf '%s\n' '#!/bin/sh' \
      '# The box denies the namespaces and setuid helper the sandbox needs;' \
      '# the container and its unprivileged user are the isolation.' \
      'exec /usr/bin/google-chrome --no-sandbox --no-first-run --no-default-browser-check "$@"' \
      > /usr/local/bin/google-chrome; \
    chmod 755 /usr/local/bin/google-chrome; \
    ln -s google-chrome /usr/local/bin/google-chrome-stable; \
    for entry in /usr/share/applications/google-chrome.desktop \
                 /usr/share/applications/com.google.Chrome.desktop \
                 /usr/share/applications/chromium.desktop; do \
      if [ -f "$entry" ]; then \
        sed -i -E 's#^Exec=/usr/bin/(google-chrome-stable|chromium)#Exec=/usr/local/bin/google-chrome#' "$entry"; \
      fi; \
    done

ENV PORT=8787 \
    AGENT_HOME=/home/agent \
    WORK_DIR=/home/agent/workspace \
    CACHE_DIR=/home/agent/.cache \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    STATE_DIR=/state \
    DESKTOP_DISPLAY=1 \
    DESKTOP_VNC_PORT=5901 \
    CHROME_BIN=/usr/local/bin/google-chrome \
    CHROME_PATH=/usr/local/bin/google-chrome

# node-pty backs the interactive terminals in the Kru UI.
WORKDIR /box
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs claude.mjs agents.mjs kru-mcp.mjs desktop.sh ./
RUN chmod 755 desktop.sh
# The session gnome-session runs: Flashback without the daemons that need
# logind or hardware (see kru.session).
COPY kru.session /usr/share/gnome-session/sessions/kru.session
# The desktop's wallpaper; desktop.sh points GNOME at it at session start.
COPY wallpaper.png /usr/share/backgrounds/kru.png

# /home/agent/.cache holds package caches (bun, npm, pnpm, yarn, pip, uv)
# so installs in a fresh clone don't hit the network every run.
# /home/agent/.claude holds the Claude Code sign-in.
VOLUME ["/state", "/home/agent/.cache", "/home/agent/.claude"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# tini reaps processes a timeout killed. Root only to run commands as the
# agent user; see server.mjs.
ENTRYPOINT ["tini", "--"]
CMD ["node", "/box/server.mjs"]
