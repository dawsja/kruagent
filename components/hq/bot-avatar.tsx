"use client";

import { Badge } from "@/components/ui/badge";
import { KruBot } from "@/components/hq/kru-bot";
import type { Bot } from "@/lib/hq/bots/registry";
import { botInk } from "@/lib/theme/bot-color";
import { cn } from "@/lib/utils";

/** A bot's face at a given size; `greet` plays the hello bounce on mount. */
export function BotAvatar({
  bot,
  size = 24,
  greet = false,
  className,
}: {
  bot: Bot;
  size?: number;
  greet?: boolean;
  className?: string;
}) {
  return (
    <span
      data-slot="bot-avatar"
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <KruBot
        color={bot.color}
        size={size}
        expression={bot.expression}
        greet={greet}
        tilt={bot.tilt}
        label={`${bot.name}, ${bot.role}`}
      />
    </span>
  );
}

/** The pill on a card while a bot has it: face, then "Momo building". */
export function BotBadge({ bot, label, className }: { bot: Bot; label: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 pl-1", className)}
      style={{ borderColor: `${bot.color}66`, color: botInk(bot.color) }}
    >
      <BotAvatar bot={bot} size={14} />
      {label}
    </Badge>
  );
}
