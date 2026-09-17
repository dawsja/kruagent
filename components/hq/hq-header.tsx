"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/landing/brand-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/theme-provider";
import { authClient } from "@/lib/auth/client";
import { isTheme, type Theme } from "@/lib/theme/theme";

const REPO_URL = "https://github.com/dawsja/kruagent";

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
];

/** System / Dark / Light, shown as a radio group inside the account menu. */
function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => {
          if (isTheme(value)) setTheme(value);
        }}
      >
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            // Keep the menu open so the change can be previewed and compared.
            closeOnClick={false}
          >
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

type PublicConnection = {
  provider: string;
  meta?: Record<string, string>;
};

/** `actions` renders before the account menu, for page-specific buttons. */
export function HqHeader({ actions }: { actions?: ReactNode } = {}) {
  const router = useRouter();
  const header = useRef<HTMLElement>(null);
  const { data: session } = authClient.useSession();
  const [avatar, setAvatar] = useState<string | null>(null);
  const name =
    (session?.user as { username?: string } | undefined)?.username ??
    session?.user.name ??
    "Account";

  useEffect(() => {
    void fetch("/api/onboarding")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { connections?: PublicConnection[] } | null) => {
        const github = data?.connections?.find((item) => item.provider === "github");
        setAvatar(
          github?.meta?.avatar ||
            (github?.meta?.login
              ? `https://github.com/${github.meta.login}.png?size=96`
              : null),
        );
      })
      .catch(() => {
        /* no avatar */
      });
  }, []);

  // Panels that open below the header read its height from this variable,
  // so they never slide in behind it.
  useEffect(() => {
    const node = header.current;
    if (!node) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--hq-header-h", `${node.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--hq-header-h");
    };
  }, []);

  async function signOut() {
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <header ref={header} className="sticky top-0 z-50 border-b border-fog/80 bg-linen/75 px-4 py-3 backdrop-blur-xl backdrop-saturate-150 sm:px-6">
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4">
        <Link
          href="/app"
          className="flex items-center gap-2 text-[14px] font-medium tracking-[-0.32px]"
        >
          <BrandMark />
          Kru
          <span className="text-ash">/ board</span>
        </Link>
        <div className="flex items-center gap-2">
        {actions}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar size="default">
              {avatar ? <AvatarImage src={avatar} alt="" /> : null}
              <AvatarFallback>{name.slice(0, 1).toUpperCase() || "K"}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 min-w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{name}</DropdownMenuLabel>
              <DropdownMenuItem nativeButton={false} render={<Link href="/app/settings" />}>
                <Settings />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                nativeButton={false}
                render={<a href={REPO_URL} target="_blank" rel="noopener noreferrer" />}
              >
                <GitHubMark />
                Star on GitHub
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <ThemeMenu />
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void signOut()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
