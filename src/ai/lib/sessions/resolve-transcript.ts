import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { findSessionsByTitle } from "@genesiscz/utils/ai/transcripts/session-title";
import type { TurnProvider } from "@genesiscz/utils/ai/transcripts/turn-state";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("agent-wait");

async function resolveByTitle(alias: TurnProvider, query: string, first: boolean): Promise<ResolvedTranscript | null> {
    const hits = findSessionsByTitle(query, { provider: alias });

    if (hits.length === 0) {
        return null;
    }

    if (hits.length > 1 && !first) {
        const lines = hits.slice(0, 6).map((hit) => `  ${hit.sessionId}  ${hit.title}`);
        throw new Error(
            `"${query}" names ${hits.length} ${alias} sessions. Pass the session id, or --first for the newest:\n${lines.join("\n")}`
        );
    }

    return resolveTranscript(hits[0].locator, {}, alias);
}

/**
 * The transcript a query names: a session id (or 8+ character prefix), a transcript path, or a `/rename`
 * title. Native sessions only; a `tools <agent> worker` session has its own verbs.
 */
export async function resolveSessionTranscript(
    alias: TurnProvider,
    query: string,
    first: boolean
): Promise<ResolvedTranscript> {
    let resolved: ResolvedTranscript | null = null;

    try {
        resolved = await resolveTranscript(query, {}, alias);
    } catch (err) {
        log.debug({ err, query, alias }, "no session id or path matched; trying titles");
    }

    // An 8+ character query also matches worker NAMES by substring, so a title can lose to a worker
    // that merely contains it. A native session with that title wins.
    if (!resolved || resolved.source === "worker") {
        resolved = (await resolveByTitle(alias, query, first)) ?? resolved;
    }

    if (!resolved) {
        throw new Error(`No ${alias} session matches "${query}" (tried session id, path and /rename title)`);
    }

    if (resolved.source === "worker") {
        throw new Error(
            `"${query}" is a headless worker session. Use \`tools ${alias} worker\` (or \`tools ${alias} wait\` on a TUI session id).`
        );
    }

    return resolved;
}
