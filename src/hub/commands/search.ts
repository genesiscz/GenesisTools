import { parseHistoryDate } from "@genesiscz/utils/agent-sessions/history-date";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { isSearchProvider, SEARCH_LIMITS, SEARCH_PROVIDERS, type SearchProvider, searchSessions } from "../lib/search";

function parseDay(value: string | undefined, flag: string): Date | undefined {
    if (value === undefined) {
        return undefined;
    }

    const date = parseHistoryDate({ value });

    if (Number.isNaN(date.getTime())) {
        throw new Error(`${flag} takes a date ("yesterday", "7 days ago", 2026-09-20), got "${value}"`);
    }

    return date;
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search <query...>")
        .description(
            "Search the transcripts of every indexed agent session (claude, codex, grok) through each provider's history search; results grouped by session"
        )
        .option("--provider <list>", `comma-separated: ${SEARCH_PROVIDERS.join(",")} (default all)`)
        .option("-p, --project <name>", "only sessions of this project (leaf folder name)")
        .option("--since <date>", "sessions active since ('yesterday', '7 days ago', 2026-09-20)")
        .option("--until <date>", "sessions active until")
        .option(
            "-l, --limit <n>",
            `sessions per provider and in total (default ${SEARCH_LIMITS.default}, max ${SEARCH_LIMITS.max})`
        )
        .option("--json", "machine-readable output (the hub's search panel reads this)")
        .action(
            async (
                words: string[],
                opts: {
                    provider?: string;
                    project?: string;
                    since?: string;
                    until?: string;
                    limit?: string;
                    json?: boolean;
                }
            ) => {
                const query = words.join(" ").trim();
                let providers: SearchProvider[] | undefined;
                let since: Date | undefined;
                let until: Date | undefined;
                let limit: number | undefined;

                try {
                    if (opts.provider !== undefined) {
                        const list = opts.provider
                            .split(",")
                            .map((entry) => entry.trim())
                            .filter(Boolean);
                        const bad = list.find((entry) => !isSearchProvider(entry));

                        if (bad !== undefined || list.length === 0) {
                            throw new Error(
                                `--provider takes ${SEARCH_PROVIDERS.join(", ")}, got "${bad ?? opts.provider}"`
                            );
                        }

                        providers = list.filter(isSearchProvider);
                    }

                    since = parseDay(opts.since, "--since");
                    until = parseDay(opts.until, "--until");

                    if (opts.limit !== undefined) {
                        limit = Number(opts.limit);

                        if (!Number.isInteger(limit) || limit < 1) {
                            throw new Error(`--limit takes a positive whole number, got "${opts.limit}"`);
                        }
                    }

                    if (!query) {
                        throw new Error("<query> must not be empty");
                    }
                } catch (error) {
                    out.log.error(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                    return;
                }

                const result = await searchSessions({ query, providers, project: opts.project, since, until, limit });

                if (opts.json) {
                    out.result(result);
                    return;
                }

                renderCliHeader("Session search", `"${query}"`);

                if (result.results.length === 0) {
                    out.println("No session matches.");
                } else {
                    const table = createBoxTable(["WHEN", "PROVIDER", "PROJECT", "SESSION", "MATCH"]);

                    for (const hit of result.results) {
                        table.push([
                            hit.mtime.slice(0, 16).replace("T", " "),
                            hit.provider,
                            hit.project ?? "",
                            `${hit.title.slice(0, 48)}\n${pc.dim(hit.sessionId)}`,
                            (hit.snippets[0]?.text ?? "").slice(0, 70),
                        ]);
                    }

                    out.println(table.toString());
                }

                const per = Object.entries(result.providers)
                    .map(
                        ([name, report]) =>
                            `${name} ${report.error ? pc.red(`failed: ${report.error}`) : `${report.hits} (${report.ms} ms)`}`
                    )
                    .join(" · ");
                out.println(pc.dim(`${result.results.length} sessions · ${per} · ${result.elapsedMs} ms`));
            }
        );
}
