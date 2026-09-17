#!/bin/bash
# Starts the box desktop as the agent user: a TigerVNC X server on loopback
# and a GNOME Flashback session on it. server.mjs runs this in its own
# process group and kills the group to stop the desktop, so everything
# started here dies together.
#
# Environment (set by server.mjs): DISPLAY (":1"), DESKTOP_VNC_PORT,
# DESKTOP_WIDTH, DESKTOP_HEIGHT, XDG_RUNTIME_DIR.
set -u

port="${DESKTOP_VNC_PORT:-5901}"
width="${DESKTOP_WIDTH:-1280}"
height="${DESKTOP_HEIGHT:-800}"
display="${DISPLAY:-:1}"
number="${display#:}"

mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
# gnome-flashback draws icons from ~/Desktop and warns when it's missing.
mkdir -p "$HOME/Desktop"
# A stale lock from a killed server would keep the display from starting.
rm -f "/tmp/.X${number}-lock" "/tmp/.X11-unix/X${number}"

Xtigervnc "$display" \
  -geometry "${width}x${height}" -depth 24 \
  -rfbport "$port" -localhost yes -SecurityTypes None \
  -AlwaysShared -AcceptSetDesktopSize \
  -desktop "Kru box" -nolisten tcp &
xpid=$!

cleanup() {
  kill "$xpid" 2>/dev/null
  wait "$xpid" 2>/dev/null
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${number}" ] && break
  kill -0 "$xpid" 2>/dev/null || { echo "[desktop] X server exited" >&2; exit 1; }
  sleep 0.2
done

# Quieter session: no lock screen or idle blanking in a box nobody logs into,
# and no accessibility bus or crash reporters to warn about.
export XDG_SESSION_TYPE=x11
export XDG_CURRENT_DESKTOP="GNOME-Flashback:GNOME"
export XDG_SESSION_DESKTOP=gnome-flashback-metacity
export NO_AT_BRIDGE=1
export GTK_A11Y=none
export TERM=xterm-256color
export COLORTERM=truecolor
export SHELL=/bin/bash
unset CI

# Applied inside the session bus so dconf picks them up.
settings() {
  gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null
  gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null
  gsettings set org.gnome.desktop.lockdown disable-lock-screen true 2>/dev/null
  # The Kru wallpaper (box/wallpaper.png): a logo on flat #2b2b2b. Scaled
  # rather than zoomed so it's never cropped, whatever the panel's shape;
  # the fill colour matches, so the bands don't show.
  gsettings set org.gnome.desktop.background picture-uri 'file:///usr/share/backgrounds/kru.png' 2>/dev/null
  gsettings set org.gnome.desktop.background picture-uri-dark 'file:///usr/share/backgrounds/kru.png' 2>/dev/null
  gsettings set org.gnome.desktop.background picture-options 'scaled' 2>/dev/null
  gsettings set org.gnome.desktop.background color-shading-type 'solid' 2>/dev/null
  gsettings set org.gnome.desktop.background primary-color '#2b2b2b' 2>/dev/null
}
export -f settings

# gnome-session's built-in manager runs the session without systemd;
# kru.session (installed by the Dockerfile) is Flashback trimmed for a box.
dbus-run-session -- bash -c 'settings; exec gnome-session --builtin --session=kru' \
  > "$XDG_RUNTIME_DIR/desktop.log" 2>&1
status=$?
echo "[desktop] session ended with status $status" >&2
# server.mjs reports the last lines of stderr when the desktop dies
# unexpectedly; give it the session's own last words.
[ "$status" -ne 0 ] && tail -n 5 "$XDG_RUNTIME_DIR/desktop.log" >&2
exit "$status"
