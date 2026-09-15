import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { canonicalPath } from "@genesiscz/utils/paths";
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

    // `sourceHome` is stored realpath-resolved, while the preferred home arrives as the raw
    // `CLAUDE_CONFIG_DIR` or an unresolved `join(homedir(), ".claude")`. Comparing them as
    // strings meant a symlinked home, a trailing slash or a `~` turned this whole collapse into
    // a silent no-op, and the query reported as ambiguous again.
    //
    // `canonicalPath` is a `realpathSync` syscall, and `isPreferred` runs over every row TWICE
    // below. `matches` is not bounded by DEFAULT_RESUME_MATCHES when it arrived from the
    // title/summary rung, which filters a listing whose limit is MAX_SAFE_INTEGER, so that is
    // 2N syscalls for an N in the thousands. There are only ever a handful of distinct homes,
    // so the answer is cached per home string and each one costs one syscall per call.
    const resolved = new Map<string, string>();
    const canonical = (home: string): string => {
        const cached = resolved.get(home);

        if (cached !== undefined) {
            return cached;
        }

        let value = home;

        try {
            value = canonicalPath(home);
        } catch (error) {
            // `canonicalPath` swallows ENOENT and rethrows everything else, so a home under a
            // directory answering EACCES or ELOOP would abort the resume itself. Preferring the
            // launch home's copy is a ranking, never a reason to refuse: degrade to the plain
            // string compare this replaced and let the query resolve or report as ambiguous.
            logger.debug({ home, error }, "[agent-sessions] source home did not resolve; comparing it as a string");
        }

        resolved.set(home, value);
        return value;
    };

    const preferred = canonical(preferredHome);
    const isPreferred = (session: AgentSession) =>
        Boolean(session.sourceHome) && canonical(session.sourceHome as string) === preferred;
    const local = new Set(matches.filter(isPreferred).map((session) => session.sessionId));

    return matches.filter((session) => isPreferred(session) || !local.has(session.sessionId));
}

/**
 * True when the query NAMES this session rather than merely appearing somewhere inside it.
 *
 * Only an identity match may skip the transcript pass. A title hit is NOT identity: `title` falls
 * back to the opening prompt (`fallbackTitle` in ./service.ts), so one word said once in a first
 * prompt otherwise suppressed the content search that finds the session saying it 207 times.
 */
function identifiesSession(session: AgentSession, trimmed: string): boolean {
    const q = trimmed.toLowerCase();

    return (
        session.sessionId.toLowerCase().startsWith(q) ||
        session.sourceKey === trimmed ||
        session.filePath === trimmed ||
        session.title.trim().toLowerCase() === q
    );
}

/**
 * The one row the metadata rung and the content rung both returned counts once.
 *
 * 🛑 This does NOT collapse one native session indexed from several homes. `historySourceKey`
 * (./identity.ts) puts the realpath'd home INSIDE the key, so those copies carry different
 * `sourceKey`s and all survive here; `preferHomeCopies` above is what picks the launch home's
 * copy, and only when the caller knows which home that is. Reading this as a cross-home collapse
 * makes `preferHomeCopies` look redundant, and deleting it restores the ambiguity it removed.
 *
 * `sourceKey` is the identity every production row carries (`resultFromMetadata` in ./service.ts
 * reads a NOT NULL column); the rest of the chain only serves hand-built rows.
 */
function dedupeSessions(sessions: AgentSession[]): AgentSession[] {
    const seen = new Set<string>();

    return sessions.filter((session) => {
        const key = session.sourceKey ?? session.filePath ?? `${session.sourceHome ?? ""}:${session.sessionId}`;

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

interface SelectResumeOptions {
    adapter: AgentSessionAdapter;
    query: string;
    filters?: AgentSearchFilters;
    interactive?: boolean;
    /** Explicit native IDs prefer the selected launch home over retained source backups. */
    preferredHome?: string;
}

/**
 * Resolve within one provider; native ID, metadata, then transcript content.
 *
 * The spinner lives HERE, not at the caller. The search and the picker share one function, and
 * a caller that wraps the whole call in its own spinner keeps that spinner animating while the
 * table picker is on screen. The two then redraw the same lines: as soon as the picker scrolls
 * in a short terminal, the spinner frame sits inside the rows, the picker erases the wrong lines
 * and looks stuck. Only this function knows the moment the search ends and the picker begins.
 */
export async function selectResumeSession(options: SelectResumeOptions): Promise<AgentSession | undefined> {
    const interactive = options.interactive ?? isInteractive();
    const spinner = interactive ? searchSpinner(options.adapter.kind) : undefined;

    try {
        return (await resolveResumeSession(options, interactive, spinner)).session;
    } catch (error) {
        spinner?.stop("History search failed");
        throw error;
    }
}

interface SearchSpinner {
    /** Idempotent: the resolver stops it before the picker, the error path stops it after a throw. */
    stop(message: string): void;
}

function searchSpinner(kind: string): SearchSpinner {
    const spinner = p.spinner();
    let stopped = false;
    spinner.start(`Searching ${kind} history: index, then transcripts...`);

    return {
        stop(message) {
            if (stopped) {
                return;
            }

            stopped = true;
            spinner.stop(message);
        },
    };
}

async function resolveResumeSession(
    options: SelectResumeOptions,
    interactive: boolean,
    spinner: SearchSpinner | undefined
): Promise<{ session: AgentSession | undefined }> {
    const { adapter, query, filters = {} } = options;
    const DEFAULT_RESUME_MATCHES = 20;
    const trimmed = query.trim();
    const normalized = trimmed.toLowerCase();
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
    // `sourceKey` and `filePath` are identity too, not decoration: `assertClaudeResumeHome` tells
    // the user to rerun as `tools claude resume <filePath> --all-projects`, and without this rung
    // the command the code itself prints resolves nothing.
    let matches = sessions.filter(
        (session) =>
            session.sessionId.toLowerCase() === normalized ||
            session.sourceKey === trimmed ||
            session.filePath === trimmed
    );
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

    // A metadata hit does NOT stand in for the content pass unless it IDENTIFIES the session.
    // Gating on `matches.length` instead meant a single weak title hit both suppressed the search
    // AND, being the only match, was returned with no picker and no ambiguity error.
    if (!matches.some((session) => identifiesSession(session, trimmed))) {
        // `scope` lifts the limit so exact identity resolution can enumerate everything; the
        // full-text fallback must not inherit that, or it hydrates the whole corpus.
        const hits = await prof.measureAsync(`resume.search.${adapter.kind}`, () =>
            adapter.search({ ...scope, query, limit: filters.limit ?? DEFAULT_RESUME_MATCHES })
        );

        matches = dedupeSessions([...matches, ...hits.filter((session) => session.kind === adapter.kind)]);
    }

    if (!matches.length) {
        throw new Error(`No ${adapter.kind} session matches "${query}" in this project scope`);
    }
    matches = preferHomeCopies(matches, options.preferredHome);
    if (matches.length === 1) {
        spinner?.stop("1 matching session");
        return { session: matches[0] };
    }
    // Claude's resume has always printed the candidates before refusing, and the shared path
    // named only the count. A count tells the user the query was too broad and nothing about
    // which query would be narrow enough, so both doors now print the table first.
    const candidates = matches.map(toSessionDisplay);
    spinner?.stop(`${matches.length} matching sessions`);

    if (!interactive) {
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

    return { session: picked ? matches[candidates.indexOf(picked)] : undefined };
}
