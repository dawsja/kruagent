/*
 * The browser clipboard, as the box terminal and desktop need it. The async
 * clipboard API only exists on secure origins (https, or localhost), so the
 * copy helper degrades to the legacy command instead of throwing. Nothing
 * here reads the clipboard: browsers meet a read with a prompt or a floating
 * Paste button, so pasted text is taken from paste events only.
 */

/**
 * Puts `text` on the clipboard. Falls back to the legacy copy command,
 * which still works on plain-http origins inside a click or keypress.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* no permission, no focus, or no gesture: try the old way */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  } catch {
    return false;
  }
}

/**
 * True for the keys that paste: Ctrl+V and Ctrl+Shift+V (Cmd+V on a Mac),
 * and Shift+Insert. These are the chords a browser turns into a paste
 * event when nothing stops them.
 */
export function isPasteChord(event: KeyboardEvent) {
  if (event.altKey) return false;
  const primary = event.ctrlKey || event.metaKey;
  if (event.code === "KeyV" && primary) return true;
  return event.code === "Insert" && event.shiftKey && !primary;
}

/** True for the keys that copy in a terminal: Ctrl+Shift+C and Ctrl+Insert. */
export function isTerminalCopyChord(event: KeyboardEvent) {
  if (event.altKey) return false;
  if (event.code === "KeyC" && event.shiftKey && (event.ctrlKey || event.metaKey)) return true;
  return event.code === "Insert" && event.ctrlKey && !event.shiftKey;
}
