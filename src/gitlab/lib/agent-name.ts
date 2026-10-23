import { env } from "@genesiscz/utils/env";

/**
 * Who signs a review. `--agent` wins; without it the name comes from `GENESIS_TOOLS_AGENT`, so a Fable or Codex
 * session names itself instead of inheriting "Opus".
 */
export function defaultAgentName(fallback = "Opus"): string {
    const fromEnv = env.agents.getName()?.trim();
    return fromEnv ? fromEnv : fallback;
}
