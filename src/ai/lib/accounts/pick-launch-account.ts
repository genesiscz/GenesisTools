import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { logger } from "@genesiscz/utils/logger";
import { resolveAccountName } from "./select-account";

/**
 * Which account an INTERACTIVE launch runs as, for any coding-agent tool.
 *
 * `tools claude run` has always prompted when the account was left out. `tools codex run`
 * declared it as a required positional instead, so `tools codex run --resume astra` died on
 * `missing required argument 'account'` — commander binds `astra` to the optional-value
 * `--resume` and then finds nothing for the positional. `tools grok run` had no account concept
 * at all. One picker for all three.
 *
 * The usage hints come from the poller's cache only. This sits in front of an interactive
 * launch, so it must never wait on the network.
 */

/** Cached usage per account id, or an empty map when the poller has never run. */
async function usageHints(provider: string): Promise<Map<string, string>> {
    const hints = new Map<string, string>();

    try {
        const cache = await readSnapshotsCache();

        for (const snapshot of cache?.providers[provider]?.accounts ?? []) {
            const hint = hintFrom(snapshot);

            if (hint) {
                hints.set(snapshot.accountId, hint);
            }
        }
    } catch (error) {
        logger.debug({ error, provider }, "[ai] usage cache unreadable; the account picker shows no hints");
    }

    return hints;
}

function hintFrom(snapshot: AccountUsageSnapshot): string | undefined {
    if (snapshot.error) {
        return snapshot.error;
    }

    const windows = snapshot.limits
        .filter((limit) => Number.isFinite(limit.percentUsed))
        .slice(0, 2)
        .map((limit) => `${limit.label} ${Math.round(limit.percentUsed)}%`);

    return windows.length > 0 ? windows.join(" · ") : undefined;
}

export interface LaunchAccountInput {
    alias: AccountProviderAlias;
    /** Command name for the non-interactive hint, e.g. `tools codex run`. */
    tool: string;
    /** The positional the user typed. Given, the prompt is skipped entirely. */
    requested?: string;
    subcommand?: string[];
}

/**
 * The account to launch as, or null when the user cancelled or nothing resolved.
 *
 * Null is not an error to report: `resolveAccountName` has already said what was wrong and
 * `process.exitCode` is set. The caller returns quietly.
 */
export async function pickLaunchAccount(input: LaunchAccountInput): Promise<AccountEntry | null> {
    const provider = PROVIDER_ALIASES[input.alias];
    const accounts = (await AiConfigStore.load()).accounts({ provider, enabled: true });
    // Only for the prompt: a named account skips the picker, so the cache read would be waste.
    const hints = input.requested ? new Map<string, string>() : await usageHints(provider);
    const picked = await resolveAccountName({
        ...(input.requested === undefined ? {} : { requested: input.requested }),
        accounts,
        message: `Run the ${input.alias} terminal as which account?`,
        tool: input.tool,
        ...(input.subcommand === undefined ? {} : { subcommand: input.subcommand }),
        hintOf: (account) => hints.get(account.id),
        fuzzy: true,
    });

    if (picked.status === "cancelled") {
        p.cancel("Cancelled");
        return null;
    }

    if (picked.status === "error") {
        process.exitCode = 1;
        return null;
    }

    return picked.account;
}
