/**
 * The colour theme is a class on <html>: `.dark` selects the dark token set in
 * globals.css, its absence the light set. The user's explicit choice lives in
 * localStorage under THEME_STORAGE_KEY; "system" (or nothing stored) follows
 * the OS `prefers-color-scheme`.
 *
 * This module is plain TS with no React so the root layout can inline
 * THEME_INIT_SCRIPT into <head>, applying the class before first paint.
 */

export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<Theme, "system">;

export const THEME_STORAGE_KEY = "kru-theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function readStoredTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * Runs synchronously while <head> parses, so a stored or system dark
 * preference never flashes the light theme. Keep it in step with the
 * functions above; it is duplicated rather than imported because it has
 * to be a self-contained string.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
