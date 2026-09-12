import { isInteractive } from "@genesiscz/utils/cli";
import { profiler } from "@genesiscz/utils/profile";
import { tableSelect } from "@genesiscz/utils/prompts/clack/table-select";
import { buildSessionTableOpts, printAmbiguousSessions, toSessionDisplay } from "./session-display";
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
    // Claude's resume has always printed the candidates before refusing, and the shared path
    // named only the count. A count tells the user the query was too broad and nothing about
    // which query would be narrow enough, so both doors now print the table first.
    const candidates = matches.map(toSessionDisplay);

    if (!(options.interactive ?? isInteractive())) {
        printAmbiguousSessions(candidates);
        throw new Error(
            `Ambiguous ${adapter.kind} resume (${matches.length} matches). Pass a session id from the table above, or use an interactive terminal.`
        );
    }

    // The same column-aligned picker Claude uses, not a one-line `p.select`: the rows differ by
    // project, branch and age, and a label plus a hint only shows the hint for the focused row.
    const picked = await tableSelect(
        buildSessionTableOpts(candidates, { message: `Resume which ${adapter.kind} session?`, query })
    );

    return picked ? matches[candidates.indexOf(picked)] : undefined;
}
