import { readFileSync } from "node:fs";
import { recordedSessionIdOf } from "@app/cmux/lib/session-close";
import { fileSessionStore, type SessionCreatedRecord, type SessionRecordLine } from "@app/cmux/lib/session-store";
import {
    type ResolvedTranscript,
    resolveCodexNative,
    resolveTranscript,
} from "@genesiscz/utils/ai/transcripts/resolve";
import { findSessionsByTitle } from "@genesiscz/utils/ai/transcripts/session-title";
import type { TurnProvider } from "@genesiscz/utils/ai/transcripts/turn-state";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { loadAllSessionCmuxRefs, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("agent-wait");

/**
 * The native session id of the newest session `tools cmux agents new --name <query>` started for this agent, open
 * or closed, through the cmux-refs journal. A cmux name is not a `/rename` title, so the other lookups never find it
 * (2026-10-13: `tools grok wait mcp-verify-grok` failed for a session `agents new` had just started).
 */
export function cmuxNamedSessionId(input: {
    alias: TurnProvider;
    query: string;
    records: readonly SessionRecordLine[];
    refs: Iterable<SessionCmuxRefs>;
}): string | null {
    const record = input.records
        .filter(
            (line): line is SessionCreatedRecord =>
                line.type === "created" && line.name === input.query && line.agent === input.alias
        )
        .at(-1);

    if (!record) {
        return null;
    }

    return recordedSessionIdOf({ record, refs: input.refs, tmuxPanes: record.tmuxPane ? [record.tmuxPane] : [] });
}

async function resolveByCmuxName(alias: TurnProvider, query: string): Promise<ResolvedTranscript | null> {
    const sessionId = cmuxNamedSessionId({
        alias,
        query,
        records: fileSessionStore().read(),
        refs: loadAllSessionCmuxRefs().values(),
    });

    if (!sessionId) {
        return null;
    }

    log.debug({ alias, query, sessionId }, `matched a ${toolCommand("cmux agents")} name`);
    return resolveTranscript(sessionId, {}, alias);
}

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

/** Nothing matched the query at all; every other error from `resolveSessionTranscript` tells the user what to do. */
export class NoSessionMatchError extends Error {}

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
        resolved = await resolveByCmuxName(alias, query);
    }

    if (!resolved) {
        throw new NoSessionMatchError(
            `No ${alias} session matches "${query}" (tried session id, path, /rename title and ${toolCommand("cmux agents")} name)`
        );
    }

    if (resolved.source === "worker") {
        // A `tools codex spawn` worker runs a real native thread: its rollout is the transcript to wait on.
        let codexHome: string | undefined;

        if (resolved.provider === "codex") {
            try {
                const meta: unknown = SafeJSON.parse(
                    readFileSync(resolved.filePath.replace(/\.jsonl$/, ".meta.json"), "utf8")
                );
                if (meta && typeof meta === "object" && "home" in meta && typeof meta.home === "string") {
                    codexHome = meta.home;
                }
            } catch (err) {
                log.debug({ err, query }, "worker metadata unavailable while resolving its Codex home");
            }
        }

        const rollout = resolved.provider === "codex" ? resolveCodexNative(resolved.sessionId, { codexHome }) : null;

        if (rollout) {
            return rollout;
        }

        const verbs =
            alias === "claude"
                ? toolCommand("claude worker", "status|tail", "--name", "<name>")
                : `tools ${alias} status|read --name <name>`;
        throw new Error(`"${query}" is a headless worker session with no native transcript yet. Use \`${verbs}\`.`);
    }

    return resolved;
}
