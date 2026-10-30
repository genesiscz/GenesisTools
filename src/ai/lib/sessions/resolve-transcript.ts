import { matchLiveAgentSurfaces } from "@app/cmux/lib/session-adopt";
import { recordedSessionIdOf } from "@app/cmux/lib/session-close";
import { liveAgentSurfacesNow } from "@app/cmux/lib/session-close-live";
import { fileSessionStore, type SessionCreatedRecord, type SessionRecordLine } from "@app/cmux/lib/session-store";
import { harnessLocate, harnessWorker } from "@genesiscz/utils/ai/providers/harness-index";
import { directReads, type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { findSessionsByTitle } from "@genesiscz/utils/ai/transcripts/session-title";
import type { TurnProvider } from "@genesiscz/utils/ai/transcripts/turn-state";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { loadAllSessionCmuxRefs, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";

import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("agent-wait");

/** The command that reads a headless worker of the harness: the status and read verbs of its driver's worker part. */
function workerReadCommand(alias: TurnProvider): string {
    const verbs = harnessWorker(alias).verbs;
    const picked = ["status", "read"]
        .map((verb) => verbs.find((each) => each === verb || each.endsWith(` ${verb}`)))
        .filter((each): each is string => each !== undefined);
    const prefix = picked[0]?.split(" ").slice(0, -1) ?? [];

    return toolCommand(
        [alias, ...prefix].join(" "),
        picked.map((each) => each.split(" ").at(-1)).join("|"),
        "--name",
        "<name>"
    );
}

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

    if (!resolved || resolved.source === "worker") {
        resolved = (await resolveByTitle(alias, query, first)) ?? resolved;
    }

    if (!resolved || resolved.source === "worker") {
        const live = await liveAgentSurfacesNow().catch((error: unknown) => {
            log.debug({ error }, "cmux unavailable during session resolution");
            return [];
        });
        const hits = matchLiveAgentSurfaces(query, alias, live);
        if (hits.length > 1 && !first) {
            throw new Error(
                `"${query}" matches ${hits.length} running ${alias} sessions. Pass the session id or --first:\n${hits.map((hit) => `  ${hit.sessionId}  ${hit.surface.title ?? ""}  ${hit.surface.ref}`).join("\n")}`
            );
        }

        const hit = hits.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
        if (hit) {
            resolved = await resolveTranscript(hit.transcriptPath ?? hit.sessionId, {}, alias);
        }
    }

    if (!resolved) {
        resolved = await resolveByCmuxName(alias, query);
    }

    if (!resolved) {
        throw new NoSessionMatchError(
            `No ${alias} session matches "${query}" (tried session id, path, cmux surface title, /rename title and ${toolCommand("cmux agents")} name)`
        );
    }

    if (resolved.source === "worker") {
        const native = harnessLocate(resolved.provider).workerNative(resolved, directReads);

        if (native) {
            return native;
        }

        throw new Error(
            `"${query}" is a headless worker session with no native transcript yet. Use \`${workerReadCommand(alias)}\`.`
        );
    }

    return resolved;
}
