import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";
import { concurrentMap } from "@genesiscz/utils/async";
import { runCmux } from "@genesiscz/utils/cmux/lib/cli";
import { logger } from "@genesiscz/utils/logger";
import type { LiveAgentSurface } from "./session-adopt";
import { recordedSessionFor } from "./session-close";
import { liveAgentSurfacesNow } from "./session-close-live";
import { fileSessionStore, openSessions, type SessionCreatedRecord } from "./session-store";

export interface SessionDetails {
    title: string | null;
    state: "running" | "awaiting-input" | "stalled" | "held-message" | "unknown";
    lastActivityAt: string | null;
    lastMessage: string | null;
}
export type ListedAgentSession = Omit<SessionCreatedRecord, "createdBy"> &
    SessionDetails & {
        sessionId: string | null;
        createdBy: SessionCreatedRecord["createdBy"] | "adopted";
    };

/** Read transcript activity and optionally inspect the terminal for held messages; unavailable evidence remains unknown. */
export async function readSessionDetails(
    live: LiveAgentSurface,
    options: { readScreen?: boolean } = {}
): Promise<SessionDetails> {
    const details: SessionDetails = {
        title: live.surface.title,
        state: "unknown",
        lastActivityAt: null,
        lastMessage: null,
    };
    try {
        const resolved = await resolveTranscript(live.transcriptPath ?? live.sessionId, {}, live.agent);
        const snapshot = readTurnState(live.agent, resolved.filePath, { stallTimeoutMs: 15 * 60_000 });
        if (snapshot) {
            details.state =
                snapshot.state === "STALLED" ? "stalled" : snapshot.state === "RUNNING" ? "running" : "awaiting-input";
            details.lastActivityAt = new Date(snapshot.lastActivityAt).toISOString();
            details.lastMessage = snapshot.lastText || null;
        }
    } catch (error) {
        logger.debug({ error, sessionId: live.sessionId }, "cmux agent transcript unavailable");
    }

    // Held peer messages are terminal UI state, not a completed transcript turn.
    // Read by UUID only: a ref names whichever tab holds that number now.
    const screen =
        options.readScreen !== false && live.surface.id
            ? await runCmux(["read-screen", "--surface", live.surface.id, "--lines", "8"], { timeoutMs: 1500 })
            : null;
    if (screen?.code === 0 && /(?:^|\n)[^\n]*\b\d+\s+held messages?\b/i.test(screen.stdout)) {
        details.state = "held-message";
    }
    return details;
}

/** Read-only inventory: enrich named records and include native sessions that were not started by agents new. */
export async function sessionInventory(
    options: {
        records?: SessionCreatedRecord[];
        live?: LiveAgentSurface[];
        readScreen?: boolean;
        details?: (live: LiveAgentSurface) => Promise<SessionDetails>;
    } = {}
): Promise<{ recorded: ListedAgentSession[]; adoptable: ListedAgentSession[] }> {
    const records = options.records ?? openSessions(fileSessionStore().read());
    const live = options.live ?? (await liveAgentSurfacesNow());
    const results = await concurrentMap({
        items: live,
        concurrency: 4,
        fn: async (entry) => ({
            entry,
            details: await (options.details
                ? options.details(entry)
                : readSessionDetails(entry, { readScreen: options.readScreen })),
        }),
    });
    const enriched = [...results.values()];
    const recorded = records.map((record): ListedAgentSession => {
        const match = enriched.find(({ entry }) => recordedSessionFor([record], entry.surface.id ?? "") !== undefined);
        return {
            ...record,
            sessionId: match?.entry.sessionId ?? null,
            title: match?.details.title ?? null,
            state: match?.details.state ?? "unknown",
            lastActivityAt: match?.details.lastActivityAt ?? null,
            lastMessage: match?.details.lastMessage ?? null,
        };
    });
    const adoptable = enriched
        .filter(({ entry }) => !recordedSessionFor(records, entry.surface.id ?? ""))
        .map(
            ({ entry, details }): ListedAgentSession => ({
                type: "created",
                name: entry.sessionId,
                sessionId: entry.sessionId,
                agent: entry.agent,
                account: "",
                model: null,
                cwd: entry.cwd ?? "",
                window: entry.surface.window,
                workspace: entry.surface.workspace,
                workspaceId: entry.surface.workspaceId,
                surface: entry.surface.ref,
                surfaceId: entry.surface.id,
                tmuxSession: entry.tmux?.session ?? null,
                pidFile: "",
                command: "",
                createdAt: details.lastActivityAt ?? "",
                createdBy: "adopted",
                ...details,
            })
        );
    return { recorded, adoptable };
}
