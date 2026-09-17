import { BOT_IDS, type BotId, type BotStage } from "../types.ts";

/*
 * The crew: five bots with a name, a color and a job. Nothing here touches
 * the filesystem or the database, so the board and Settings can import it
 * to draw avatars and badges; the personalities live in bots/<id>/SOUL.md.
 */

export type BotRole = "coordinator" | "builder" | "tester" | "reviewer" | "scribe";

export type BotExpression = "happy" | "wink" | "surprised" | "sleepy" | "excited";

export type Bot = {
  id: BotId;
  name: string;
  color: string;
  role: BotRole;
  /** One line for the lineup: what this bot does for you. */
  tagline: string;
  /** Face for the mascot in menus and the lineup. */
  expression: BotExpression;
  tilt: number;
  /** The badge on a card while this bot has it: "Momo building". */
  verb: string;
};

export const BOTS: readonly Bot[] = [
  {
    id: "pip",
    name: "Pip",
    color: "#3B82F6",
    role: "coordinator",
    tagline: "Runs the room: picks up cards, answers you, creates work.",
    expression: "wink",
    tilt: 0,
    verb: "coordinating",
  },
  {
    id: "momo",
    name: "Momo",
    color: "#FF5A0F",
    role: "builder",
    tagline: "Builds the change in a fresh clone of the repo.",
    expression: "happy",
    tilt: -2,
    verb: "building",
  },
  {
    id: "kiko",
    name: "Kiko",
    color: "#14B8A6",
    role: "tester",
    tagline: "Runs the project's lint, tests and build, and reports.",
    expression: "surprised",
    tilt: 2,
    verb: "testing",
  },
  {
    id: "lulu",
    name: "Lulu",
    color: "#8B5CF6",
    role: "reviewer",
    tagline: "Reads the diff and sends it back when something is off.",
    expression: "sleepy",
    tilt: -1,
    verb: "reviewing",
  },
  {
    id: "bibi",
    name: "Bibi",
    color: "#EC4899",
    role: "scribe",
    tagline: "Writes the summary and the commit message for your approval.",
    expression: "excited",
    tilt: 1,
    verb: "writing",
  },
];

/** Which bot works each stage of a card. */
export const STAGE_BOT = {
  build: "momo",
  test: "kiko",
  review: "lulu",
  scribe: "bibi",
} as const satisfies Partial<Record<BotStage, BotId>>;

export function getBot(id: BotId): Bot {
  const bot = BOTS.find((item) => item.id === id);
  if (!bot) throw new Error(`Unknown bot ${id}`);
  return bot;
}

export function botForStage(stage: BotStage): Bot | null {
  const id = (STAGE_BOT as Partial<Record<BotStage, BotId>>)[stage];
  return id ? getBot(id) : null;
}

export function botName(id: string): string {
  return (BOT_IDS as readonly string[]).includes(id) ? getBot(id as BotId).name : id;
}
