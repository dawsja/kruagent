import { getBotsModel } from "../data.ts";
import { listModelsText, modelIndex, switchChatModel } from "./models.ts";

/*
 * Slash commands in the Team room, answered by Kru itself rather than a
 * model, so they work even when the chat model is the thing that's broken.
 *
 *   /models          the numbered list of models
 *   /model           the crew's chat model
 *   /model <name>    switch it, by a loose name or a number from the list
 */

export type Command = { name: "models" } | { name: "model"; query: string };

export function parseCommand(text: string): Command | null {
  const match = /^\/(models?)\b\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const query = match[2].trim();
  if (name === "models") return { name: "models" };
  return { name: "model", query };
}

/** Pip's answer to a command. */
export async function runCommand(command: Command): Promise<string> {
  if (command.name === "models" || !command.query) {
    const list = await listModelsText();
    if (command.name === "models") return `Models I can use (switch with /model <name or number>):\n${list}`;
    const current = getBotsModel();
    const entry = current ? (await modelIndex()).find((item) => item.option.id === current) : null;
    const now = entry
      ? `The crew chats with ${entry.option.name} (${entry.option.provider}).`
      : current
        ? `The crew is set to ${current}, which isn't available right now.`
        : "The crew chats with the default model.";
    return `${now} Switch with /model <name or number>:\n${list}`;
  }
  return (await switchChatModel(command.query)).message;
}
