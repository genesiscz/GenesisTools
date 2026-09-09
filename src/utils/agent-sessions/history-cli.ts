import { getAgentRuntimeContext } from "@genesiscz/utils/agent/runtime";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { formatHistoryJson, formatHistoryMarkdown, renderHistoryTable } from "./format-history";
import { parseHistoryDate } from "./history-date";
import { validateHistoryFilters } from "./native-match";
import type { AgentSearchFilters, AgentSessionAdapter } from "./types";

/** A closed set, so the flag takes an optional value and prints the list itself. */
const HISTORY_FORMATS = ["ai", "json"] as const;

export interface HistoryCliOptions {
    query?: string;
    all?: boolean;
    cwd?: string;
    project?: string;
    since?: string;
    until?: string;
    limit?: string;
    exact?: boolean;
    regex?: boolean;
    format?: string;
    interactive?: boolean;
    file?: string[];
    files?: string[];
    tool?: string;
    context?: string;
    summaryOnly?: boolean;
    agentsOnly?: boolean;
    excludeAgents?: boolean;
    excludeThinking?: boolean;
    excludeSession?: string[];
    excludeCurrent?: boolean;
    commit?: string;
    commitMsg?: string;
    sortRelevance?: boolean;
    convDate?: string;
    convDateUntil?: string;
    listSummaries?: boolean;
    json?: boolean;
}

function parseDate(value: string | undefined): Date | undefined {
    return value ? parseHistoryDate({ value }) : undefined;
}

export function filtersFromHistoryOptions(
    query: string | undefined,
    options: HistoryCliOptions,
    defaultCwd: string
): AgentSearchFilters {
    const limit = options.limit === undefined ? 20 : Number(options.limit);
    const context = options.context === undefined ? 0 : Number(options.context);
    if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(context) || context < 0) {
        throw new Error("History --limit and --context must be non-negative integers");
    }
    const project = options.all ? undefined : options.project;
    // `--project` filters by leaf name, so it must not also pin the default cwd:
    // the point of naming another project is to look outside this one.
    const cwd = options.all || project ? options.cwd : options.cwd || defaultCwd;

    return {
        query: options.listSummaries ? undefined : query,
        cwd,
        project,
        all: Boolean(options.all),
        since: parseDate(options.since),
        until: parseDate(options.until),
        // `--limit 0` means "no ceiling", as `tools claude history` has always read it. The
        // service reads a literal 0 as "return nothing", so every provider on this shared CLI
        // answered `--limit 0` with an empty listing while the Claude door listed everything.
        limit: limit === 0 ? undefined : limit,
        context,
        files: [...(options.file ?? []), ...(options.files ?? [])],
        tool: options.tool,
        summaryOnly: Boolean(options.summaryOnly || options.listSummaries),
        agentsOnly: options.agentsOnly,
        excludeAgents: options.excludeAgents,
        excludeThinking: options.excludeThinking,
        excludeSessions: options.excludeSession,
        commitHash: options.commit,
        commitMessage: options.commitMsg,
        sortByRelevance: options.sortRelevance,
        conversationDate: parseDate(options.convDate),
        conversationDateUntil: parseDate(options.convDateUntil),
        exact: Boolean(options.exact),
        regex: Boolean(options.regex),
    };
}

export function registerAgentHistoryCommand(
    program: Command,
    adapter: AgentSessionAdapter<string>,
    toolName: string
): void {
    const history = program.command("history");
    history
        .description(`Search ${adapter.kind} conversation history`)
        .argument("[query]", "Search query (fuzzy match by default)")
        .option("-i, --interactive", "Interactive mode with prompts")
        .option("-p, --project <name>", "Filter by project/cwd leaf name")
        .option("--cwd <path>", "Filter by working directory")
        .option("--all", "Search all projects (ignore cwd)")
        .option("--since <date>", "Filter by date (e.g. '7 days ago', 'yesterday')")
        .option("--until <date>", "Filter until date")
        .option("-l, --limit <n>", "Limit results", "20")
        .option("--exact", "Exact match instead of fuzzy")
        .option("--regex", "Use regex for query")
        .option("--format [type]", "Output format: ai (default), json", "ai")
        .option("--json", "Machine-readable output")
        .option("-f, --file <pattern>", "Match file paths/tool inputs (repeatable)", collect, [])
        .option("--files <pattern>", "Alias for --file (repeatable)", collect, [])
        .option("-t, --tool <name>", "Match tool names, including tool results")
        .option("-c, --context <n>", "Messages before/after each match", "0")
        .option("--summary-only", "Search titles, summaries and first prompt")
        .option("--list-summaries", "List indexed conversation topics")
        .option("--agents-only", "Only subagent conversations")
        .option("--exclude-agents", "Exclude subagent conversations")
        .option("--exclude-thinking", "Exclude available reasoning/thinking text")
        .option("--exclude-session <id>", "Exclude a session id or source key (repeatable)", collect, [])
        .option("--exclude-current", "Exclude this provider session")
        .option("--commit <hash>", "Find recorded commit hash references")
        .option("--commit-msg <text>", "Find recorded commit message content")
        .option("--sort-relevance", "Rank metadata and full-text matches")
        .option("--conv-date <date>", "Conversation start date lower bound")
        .option("--conv-date-until <date>", "Conversation start date upper bound")
        .action(async (positional: string | undefined, options: HistoryCliOptions) => {
            const query = resolveHistoryQuery(positional, options);
            if (options.interactive && !isInteractive()) {
                out.error(
                    `--interactive needs a TTY. ${suggestCommand(`tools ${toolName} history`, { add: ["--all"] })}`
                );
                process.exitCode = 1;
                return;
            }

            // A bare `--format` used to reach commander's "argument missing" with no value list,
            // and `--format yaml` threw a raw stack trace at the user. Both now name the values.
            if (typeof options.format !== "string" || !HISTORY_FORMATS.includes(options.format as "ai" | "json")) {
                out.error(
                    suggestEnumFlag(`tools ${toolName} history`, "--format", HISTORY_FORMATS, {
                        subcommand: ["history"],
                        ...(typeof options.format === "string" ? { given: options.format } : {}),
                    })
                );
                process.exitCode = 1;
                return;
            }
            if (options.excludeCurrent) {
                const runtime = getAgentRuntimeContext();
                const expected = adapter.kind === "claude" ? "claude-code" : adapter.kind;
                if (runtime.agent !== expected || !runtime.sessionId) {
                    throw new Error(`--exclude-current requires an active ${adapter.kind} session`);
                }
                options.excludeSession = [...(options.excludeSession ?? []), runtime.sessionId];
            }
            const filters = filtersFromHistoryOptions(query, options, process.cwd());

            // These messages are already the right words for a user — "Invalid history regular
            // expression", "Choose --exact or --regex, not both" — but they reached the terminal as
            // a raw stack trace with a bun version banner, the same shape `--format yaml` had.
            try {
                validateHistoryFilters(filters);
            } catch (error) {
                out.error(error instanceof Error ? error.message : "Invalid history filters");
                process.exitCode = 1;
                return;
            }

            const hits = await adapter.search(filters);

            await warnUnresolvedIdentities(adapter, toolName);

            if (hits.length === 0) {
                if (options.json || options.format === "json") {
                    out.print(formatHistoryJson([]));
                    return;
                }
                out.println("No conversations found matching your criteria.");
                return;
            }

            let selected = hits;
            if (options.interactive) {
                const p = await import("@clack/prompts");
                const choice = await withCancel(
                    p.select({
                        message: `Which ${adapter.kind} session?`,
                        options: hits.map((hit) => ({
                            value: hit.sourceKey ?? hit.sessionId,
                            label: hit.title,
                            hint: `${hit.mtime.toISOString().slice(0, 10)} · ${hit.cwd} · ${hit.sourceHome ?? "native home"} · ${hit.sessionId.slice(0, 8)}`,
                        })),
                    })
                );
                const picked = hits.find((hit) => (hit.sourceKey ?? hit.sessionId) === choice);
                selected = picked ? [picked] : [];
                if (selected.length === 0) {
                    return;
                }
            }

            if (options.json || options.format === "json") {
                out.print(formatHistoryJson(selected));
                return;
            }

            if (process.stdout.isTTY && !filters.context) {
                renderHistoryTable(selected);
            } else {
                out.print(formatHistoryMarkdown(selected, query));
            }
        });
    registerHistoryIndexCommand(history, adapter);
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/**
 * The one-way migration synthesizes a source key for every carried-over row, and only a source a
 * later search happens to refresh gets its real identity. Until then the listing is quietly short.
 * One indexed count, on stderr, naming the command that completes it.
 */
export async function warnUnresolvedIdentities(adapter: AgentSessionAdapter<string>, toolName: string): Promise<void> {
    const pending = (await adapter.unresolvedIdentities?.()) ?? 0;

    if (pending > 0) {
        // Measured on a fresh copy of the live index: 1,609 of 1,629 rows, every one a main
        // session, spread across every project. An ordinary search only heals the sources it
        // lists, so this does not clear on its own.
        out.log.warn(
            `${pending} indexed session(s) still carry the pre-index identity, so results may be ` +
                `short or show a stale title. Run \`tools ${toolName} history index\` once to ` +
                `complete the migration.`
        );
    }
}

/**
 * `history index` is claimed by the subcommand below, and `--` does not rescue it, so the literal
 * word is unreachable as a search term without an explicit option. It is declared HERE, on the
 * parent, by the same function that attaches the colliding subcommand — that is what causes the
 * shadow, so that is what should carry the escape. Commander merges options regardless of
 * registration order, so both doors get it from this one call and so does any future third.
 */
export function resolveHistoryQuery(positional: string | undefined, options: { query?: string }): string | undefined {
    return options.query ?? positional;
}

export function registerHistoryIndexCommand(history: Command, adapter: AgentSessionAdapter<string>): void {
    history.option("-q, --query <text>", "Search query; the only way to search for a subcommand name");
    history
        .command("index [action]")
        .description("Synchronize, rebuild or inspect this provider's shared history metadata")
        .option("--json", "Machine-readable index status")
        .action(async (action: string | undefined, _options: { json?: boolean }, command: Command) => {
            if (!adapter.sync || !adapter.status) {
                throw new Error(`${adapter.kind} does not support history indexing`);
            }
            if (action && !["sync", "rebuild", "status"].includes(action)) {
                throw new Error("Choose history index sync, rebuild or status");
            }
            const report =
                action === "status" ? await adapter.status() : await adapter.sync({ rebuild: action === "rebuild" });

            // `sync` refreshes metadata only, and the statistics pass is the only writer of
            // `file_index.message_count` — which is what a listing reads for its message counts.
            // Running one without the other is why "run history index" could fix the identity
            // shortfall and leave every count at zero. An explicit index means both.
            if (action !== "status" && adapter.refreshStatistics) {
                const statistics = await adapter.refreshStatistics();

                if (statistics.coverage !== "complete") {
                    out.log.warn(`Statistics coverage is ${statistics.coverage}; some counts may be missing.`);
                }
            }
            if (command.optsWithGlobals<{ json?: boolean }>().json) {
                out.result(report);
                return;
            }
            if (report.initialized === false) {
                out.println("No history metadata yet. Your first search builds it automatically.");
            }
            const table = createBoxTable(["Provider", "Sessions", "Messages", "Sources", "Issues"]);
            table.push([
                adapter.kind,
                report.sessions,
                report.messages ?? "unknown",
                report.sources,
                report.issues.length,
            ]);
            out.println(table.toString());
            if ("parsed" in report && "unchanged" in report && "removed" in report) {
                out.println(`Parsed ${report.parsed}; unchanged ${report.unchanged}; removed ${report.removed}.`);
            }
            for (const issue of report.issues) {
                out.warn(`${issue.path}: ${issue.message}`);
            }
        });
}
