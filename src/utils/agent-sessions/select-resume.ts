import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import type { AgentSearchFilters, AgentSession, AgentSessionAdapter } from "./types";

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
    const sessions = (await adapter.list(scope)).filter((session) => session.kind === adapter.kind);
    let matches = sessions.filter((session) => session.sessionId.toLowerCase() === normalized);
    if (fullNativeId) {
        if (!matches.length) {
            throw new Error(`No ${adapter.kind} session has native ID "${query}"`);
        }
        const preferred = matches.filter((session) => session.sourceHome === options.preferredHome);
        if (options.preferredHome && preferred.length === 1) {
            matches = preferred;
        }
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
        matches = (await adapter.search({ ...scope, query, limit: filters.limit ?? DEFAULT_RESUME_MATCHES })).filter(
            (session) => session.kind === adapter.kind
        );
    }
    if (!matches.length) {
        throw new Error(`No ${adapter.kind} session matches "${query}" in this project scope`);
    }
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
