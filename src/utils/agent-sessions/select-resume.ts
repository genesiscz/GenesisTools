import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import { profiler } from "@genesiscz/utils/profile";
import type { AgentSearchFilters, AgentSession, AgentSessionAdapter } from "./types";

/**
 * One native session copied into several homes is indexed once per home. The launch home's copy
 * is the one to resume; the others are the retained originals, and resuming one of those offers
 * to import a session the launch home already holds.
 */
function preferHomeCopies(matches: AgentSession[], preferredHome?: string): AgentSession[] {
    if (!preferredHome) {
        return matches;
    }
    const local = new Set(
        matches.filter((session) => session.sourceHome === preferredHome).map((session) => session.sessionId)
    );
    return matches.filter((session) => session.sourceHome === preferredHome || !local.has(session.sessionId));
}

/** Resolve within one provider; native ID, metadata, then transcript content. */
export async function selectResumeSession(options: {
    adapter: AgentSessionAdapter;
    query: string;
    filters?: AgentSearchFilters;
    interactive?: boolean;
    /** Explicit native IDs prefer the selected launch home over retained source backups. */
    preferredHome?: string;
}): Promise<AgentSession | undefined> {
    const { adapter, query, filters = {} } = options;
    const DEFAULT_RESUME_MATCHES = 20;
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        throw new Error("Resume search needs a non-empty query");
    }
    const fullNativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized);
    const scope = {
        ...filters,
        ...(fullNativeId ? { cwd: undefined, project: undefined, all: true } : {}),
        limit: Number.MAX_SAFE_INTEGER,
        query: undefined,
    };
    // The resume path for BOTH the codex and grok launchers, and the metadata refresh it triggers
    // can cost more than the SQLite scan it looks like.
    const prof = profiler.scope("agent-sessions");
    const listed = await prof.measureAsync(`resume.list.${adapter.kind}`, () => adapter.list(scope));
    const sessions = listed.filter((session) => session.kind === adapter.kind);
    let matches = sessions.filter((session) => session.sessionId.toLowerCase() === normalized);
    if (fullNativeId && !matches.length) {
        throw new Error(`No ${adapter.kind} session has native ID "${query}"`);
    }
    if (!matches.length) {
        matches = sessions.filter((session) => session.sessionId.toLowerCase().startsWith(normalized));
    }
    if (!matches.length) {
        matches = sessions.filter((session) =>
            `${session.title}\n${session.summary ?? ""}`.toLowerCase().includes(normalized)
        );
    }
    if (!matches.length) {
        // `scope` lifts the limit so exact identity resolution can enumerate everything; the
        // full-text fallback must not inherit that, or it hydrates the whole corpus.
        const hits = await prof.measureAsync(`resume.search.${adapter.kind}`, () =>
            adapter.search({ ...scope, query, limit: filters.limit ?? DEFAULT_RESUME_MATCHES })
        );
        matches = hits.filter((session) => session.kind === adapter.kind);
    }
    if (!matches.length) {
        throw new Error(`No ${adapter.kind} session matches "${query}" in this project scope`);
    }
    matches = preferHomeCopies(matches, options.preferredHome);
    if (matches.length === 1) {
        return matches[0];
    }
    if (!(options.interactive ?? isInteractive())) {
        throw new Error(
            `Multiple ${adapter.kind} sessions match "${query}"; use a full session ID or an interactive terminal`
        );
    }
    const selected = await p.select({
        message: `Resume which ${adapter.kind} session?`,
        options: matches.map((session, index) => ({
            value: index,
            label: `${session.title} · ${session.sessionId.slice(0, 8)}`,
            hint: `${session.mtime.toISOString()} · ${session.cwd} · ${session.account ?? "account unknown"} · ${session.filePath}`,
        })),
    });
    return p.isCancel(selected) ? undefined : matches[selected];
}
