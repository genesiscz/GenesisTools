import type { EmbedAccountRequest } from "@genesiscz/utils/ai/account-env";
import type { HarnessId } from "@genesiscz/utils/harness/types";

/** How the host app talks to the native binary. `tools t3 providers` matches it to a T3 Code driver. */
export type EmbedHostProtocol = "claude-stream-json" | "codex-app-server" | "acp";

export interface EmbedLaunchInput {
    /** The account the host asked for: `[account]` on the command line, else `TOOLS_<ALIAS>_EMBED_ACCOUNT`. */
    request: EmbedAccountRequest;
    /** The native argv exactly as the host passed it (everything after `--`). */
    argv: string[];
}

/**
 * One agent's door for an app that embeds it (T3 Code). It runs the native binary as the requested account with the
 * host's stdio, stamps `TOOLS_<ALIAS>_ACCOUNT` on the child so `who` can read it, and passes stop signals on. It
 * never prompts: the host has no terminal. It resolves with the child's exit code in `process.exitCode`, or exits
 * the process with that code.
 */
export interface EmbedLauncher {
    readonly alias: HarnessId;
    readonly hostProtocol: EmbedHostProtocol;
    /**
     * Whether `run` serves a `proxy:<account>/<provider>` request through the ai-proxy. `tools t3 providers add`
     * refuses a proxy instance for a launcher that does not, and its doctor reports one, because it could never start.
     */
    readonly servesProxy: boolean;
    run(input: EmbedLaunchInput): Promise<void>;
}
