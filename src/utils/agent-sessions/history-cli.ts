import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
import type { Command } from "commander";
import { formatHistoryJson, formatHistoryMarkdown } from "./format-history";
import type { AgentSearchFilters, AgentSessionAdapter } from "./types";

export interface HistoryCliOptions {
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
}

function parseDate(value: string | undefined): Date | undefined {
    if (!value) {
        return undefined;
    }

    if (value === "yesterday") {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    const days = value.match(/^(\d+)\s+days?\s+ago$/i);
    if (days) {
        const d = new Date();
        d.setDate(d.getDate() - Number(days[1]));
        return d;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function filtersFromHistoryOptions(
    query: string | undefined,
    options: HistoryCliOptions,
    defaultCwd: string
): AgentSearchFilters {
    const project = options.all ? undefined : options.project;
    // `--project` filters by leaf name, so it must not also pin the default cwd:
    // the point of naming another project is to look outside this one.
    const cwd = options.all || project ? options.cwd : options.cwd || defaultCwd;

    return {
        query,
        cwd,
        project,
        all: Boolean(options.all),
        since: parseDate(options.since),
        until: parseDate(options.until),
        limit: options.limit ? Number(options.limit) : 20,
        exact: Boolean(options.exact),
        regex: Boolean(options.regex),
    };
}

export function registerAgentHistoryCommand(program: Command, adapter: AgentSessionAdapter, toolName: string): void {
    program
        .command("history")
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
        .option("--format <type>", "Output format: ai (default), json", "ai")
        .action(async (query: string | undefined, options: HistoryCliOptions) => {
            if (options.interactive && !isInteractive()) {
                out.error(
                    `--interactive needs a TTY. ${suggestCommand(`tools ${toolName} history`, { add: ["--all"] })}`
                );
                process.exitCode = 1;
                return;
            }

            const filters = filtersFromHistoryOptions(query, options, process.cwd());
            const hits = await adapter.search(filters);

            if (hits.length === 0) {
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
                            value: hit.sessionId,
                            label: hit.title,
                            hint: hit.sessionId.slice(0, 8),
                        })),
                    })
                );
                const picked = hits.find((hit) => hit.sessionId === choice);
                selected = picked ? [picked] : [];
                if (selected.length === 0) {
                    return;
                }
            }

            if (options.format === "json") {
                out.print(formatHistoryJson(selected));
                return;
            }

            out.print(formatHistoryMarkdown(selected, query));
        });
}
