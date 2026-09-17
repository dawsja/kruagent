import { claudeCodeModelOptions, modelOptionsFor } from "./models.ts";
import { isModelProvider, type Connection } from "./types.ts";

export type ModelSource = "saved";

/**
 * Picker options for every API endpoint, from the model list saved when its
 * key was checked, plus Claude Code's models when the CLI in the box is
 * signed in: those need no connection, the CLI is its own.
 */
export function modelOptionsForConnections(connections: Connection[], claudeCode = false) {
  const endpoints = connections.filter((item) => isModelProvider(item.provider));
  return {
    options: [...modelOptionsFor(endpoints), ...(claudeCode ? claudeCodeModelOptions() : [])],
    sources: Object.fromEntries(
      endpoints.map((item) => [item.id, "saved"]),
    ) as Record<string, ModelSource>,
  };
}
