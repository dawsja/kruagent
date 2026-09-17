"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DARK_QUERY,
  THEME_STORAGE_KEY,
  applyTheme,
  isTheme,
  readStoredTheme,
  resolveTheme,
  type Theme,
} from "@/lib/theme/theme";

type ThemeContextValue = {
  /** The user's choice: "system" follows the OS preference. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The server has no storage, so it renders "system"; nothing theme-dependent
  // is drawn until the profile menu opens on the client, so no hydration
  // mismatch results. The inline script in the root layout has already set
  // the class on <html> by the time this runs.
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof window === "undefined" ? "system" : readStoredTheme(),
  );

  // In development, React's Strict Mode remount resets <html> to the
  // attributes it manages, dropping the class the inline script set. Re-apply
  // before paint; in production this is a no-op.
  useLayoutEffect(() => {
    applyTheme(resolveTheme(theme));
  }, [theme]);

  // Follow OS changes while on "system", and other tabs' changes always.
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onMedia = () => {
      if (theme === "system") applyTheme(resolveTheme("system"));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = isTheme(event.newValue) ? event.newValue : "system";
      setThemeState(next);
    };
    media.addEventListener("change", onMedia);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onMedia);
      window.removeEventListener("storage", onStorage);
    };
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(resolveTheme(next));
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode or storage disabled: the choice lasts for this page */
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
