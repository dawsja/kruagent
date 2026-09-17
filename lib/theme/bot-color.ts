/**
 * Bot identity colours are picked for dark surfaces. On light surfaces they
 * are mixed toward the ink by --bot-ink-mix (0% in dark mode) so a bot's name
 * stays legible as small text without changing its hue.
 */
export function botInk(color: string): string {
  return `color-mix(in oklab, ${color}, var(--carbon) var(--bot-ink-mix))`;
}
