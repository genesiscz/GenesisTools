import { GROK_CACHE_TTL_MS } from "@app/claude/lib/usage/session-rows";
import { grokAccountNameLookup } from "@genesiscz/utils/ai/providers/plugins/grok-sub/discover";
import { logger } from "@genesiscz/utils/logger";
import { nativeRows } from "../agent-session-rows";

/** Grok names a login by its home; a home with no account simply has none. */
function grokAccount(lookup: (home: string) => string | undefined, home: string): string | null {
    try {
        return lookup(home) ?? null;
    } catch (err) {
        // An unreadable auth file or an unparseable ai/config.json is a REASON, and silence made
        // it indistinguishable from "this home has no account" with nothing in the log.
        logger.debug({ err, home }, "[ai] grok account for home unavailable");
        return null;
    }
}

/**
 * The account lookup reads `ai/config.json` once. When that file cannot be read, the rows still list with no account:
 * account metadata must never hide the sessions themselves.
 */
async function accountLookup(): Promise<(home: string) => string | undefined> {
    try {
        return await grokAccountNameLookup();
    } catch (err) {
        logger.debug({ err }, "[ai] grok account config unavailable; rows list without an account");
        return () => undefined;
    }
}

/** Grok's rows, off the shared history index; the account answers from the session's own home. */
export const rowPart = nativeRows("grok", {
    cacheTtlMs: GROK_CACHE_TTL_MS,
    accountOf: async () => {
        const lookup = await accountLookup();
        return (record) => (record.sourceHome ? grokAccount(lookup, record.sourceHome) : null);
    },
});
