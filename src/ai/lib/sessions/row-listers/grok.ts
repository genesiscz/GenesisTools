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

/** Grok's rows, off the shared history index; the account answers from the session's own home. */
export const rowPart = nativeRows("grok", {
    cacheTtlMs: GROK_CACHE_TTL_MS,
    accountOf: async () => {
        const lookup = await grokAccountNameLookup();
        return (record) => (record.sourceHome ? grokAccount(lookup, record.sourceHome) : null);
    },
});
