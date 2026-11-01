import { embedLauncher } from "@app/ai/lib/embed/registry";
import type { EmbedHostProtocol } from "@app/ai/lib/embed/types";
import { STEER_ENV } from "@app/claude/lib/direct-run";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { HarnessId } from "@genesiscz/utils/harness/types";

/** The variable that turns an embed host's steer into a next-boundary message, and the value that does it. */
export interface T3SteerOption {
    variable: string;
    next: string;
}

/**
 * What T3 Code needs to know about one embed host protocol. An agent reaches its row through its
 * `EmbedLauncher.hostProtocol`, so this tool never names an agent.
 */
export interface T3HostSpec {
    /** The T3 Code driver id that speaks the protocol (`providerInstances.<id>.driver`). */
    driver: string;
    /** Steer support, or null when the protocol has no steer message to rewrite. */
    steer: T3SteerOption | null;
    /** Which configured accounts of the agent `providers sync` turns into instances. */
    syncs(account: AccountEntry): boolean;
}

/**
 * Checked against `_Playgrounds/t3code` on 2026-11-01: `apps/server/src/provider/Drivers/ClaudeDriver.ts`
 * (`claudeAgent`), `CodexDriver.ts` (`codex`), `packages/provider-grok/src/server/driver.ts` (`grok`, an ACP client).
 */
export const T3_HOSTS = {
    "claude-stream-json": {
        driver: "claudeAgent",
        // The stream-json host sends a steer as a `priority: "now"` user message; `src/claude/lib/direct-run.ts`
        // rewrites it to `next` when this variable says so.
        steer: { variable: STEER_ENV, next: "next" },
        // Its launcher runs `tools claude run --sdk <account>`, which runs a named account on its long-lived token.
        syncs: (account) => Boolean(account.credentials.longLivedToken),
    },
    "codex-app-server": {
        driver: "codex",
        steer: null,
        syncs: () => true,
    },
    acp: {
        driver: "grok",
        steer: null,
        syncs: () => true,
    },
} satisfies Record<EmbedHostProtocol, T3HostSpec>;

/** The T3 Code facts for one agent, through its embed launcher's host protocol. */
export async function t3HostFor(alias: HarnessId): Promise<T3HostSpec> {
    return T3_HOSTS[(await embedLauncher(alias)).hostProtocol];
}
