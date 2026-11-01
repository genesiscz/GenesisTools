import type { HarnessId, Lazy } from "@genesiscz/utils/harness/types";
import type { EmbedLauncher } from "./types";

/**
 * Every agent's embed launcher, loaded on demand. The table is exhaustive over the harness ids, so a new agent fails
 * to compile until it brings its own `<tool>/lib/embed.ts`.
 */
export const EMBED_LAUNCHERS = {
    claude: async () => (await import("@app/claude/lib/embed")).claudeEmbed,
    codex: async () => (await import("@app/codex/lib/embed")).codexEmbed,
    grok: async () => (await import("@app/grok/lib/embed")).grokEmbed,
} satisfies Record<HarnessId, Lazy<EmbedLauncher>>;

export function embedLauncher(alias: HarnessId): Promise<EmbedLauncher> {
    return EMBED_LAUNCHERS[alias]();
}
