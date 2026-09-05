import { resolveRangeFlag } from "@app/ai/lib/usage/range-flag";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { RANGE_VALUES } from "@genesiscz/utils/ink/usage-dashboard/types";
import { logger, out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { Command } from "commander";

/** `-f` is repeatable and additive; `--account` is the variadic spelling of the same list. */
function collectFilter(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface UsageOptions {
    account?: string[];
    filter?: string[];
    range?: string | boolean;
    token?: string;
    tui?: boolean;
    json?: boolean;
    scored?: boolean;
    watch?: boolean;
    fresh?: boolean;
}

export function registerUsageCommand(program: Command): void {
    const usage = program
        .command("usage")
        .description("Show Claude API usage dashboard (interactive TUI)")
        .option("--account <name...>", "Limit to these account names")
        .option("-f, --filter <account>", "Alias of --account, kept for scripts", collectFilter, [])
        .option("--range [value]", `History range: ${RANGE_VALUES.join(" | ")}`)
        .option("--token <token>", "Use a specific OAuth access token")
        .option("--no-tui", "Use legacy plain text output")
        .option("--json", "Output as JSON")
        .option("--scored", "With --json, emit sortGrouped(scoreAccounts(...))")
        .option("--watch", "Watch mode (legacy)")
        .option("--fresh", "Force a live Anthropic fetch, bypassing the shared cache");

    usage
        .command("sessions")
        .description("List Claude sessions with 1h prompt-cache status as JSON")
        .option("--json", "Output as JSON")
        .option("--hours <n>", "Only sessions with mtime within this many hours", "6")
        .option("--min <n>", "If fewer than N rows after --hours, append older sessions")
        .action(async (opts: { json?: boolean; hours?: string; min?: string }) => {
            const hoursRaw = typeof opts.hours === "string" ? opts.hours : "6";
            const hours = Number.parseInt(hoursRaw, 10);

            if (!Number.isFinite(hours) || hours < 0) {
                logger.error("--hours must be a non-negative integer");
                process.exit(1);
            }

            let minRows: number | undefined;
            if (opts.min !== undefined) {
                minRows = Number.parseInt(opts.min, 10);
                if (!Number.isFinite(minRows) || minRows < 1) {
                    logger.error("--min must be a positive integer");
                    process.exit(1);
                }
            }

            const prof = profiler.scope("claude-sessions");
            const { listSessionRowsWithTimings } = await import("@app/claude/lib/usage/session-rows");
            const { rows, timings } = await prof.measureAsync("list", () =>
                listSessionRowsWithTimings({ hours, minRows, excludeSubagents: true })
            );
            logger.debug({ timings }, "usage sessions timings");
            prof.summary("usage sessions");
            out.result({ fetchedAt: Date.now(), rows, timings });
            await out.flush();
        });

    usage.action(async (opts: UsageOptions) => {
        const names = [...(opts.account ?? []), ...(opts.filter ?? [])];
        const accountFilter = names.length > 0 ? names : undefined;

        if (opts.scored && !opts.json) {
            logger.error("use --json --scored");
            process.exit(1);
        }

        const range = resolveRangeFlag(opts.range);

        if (range.status === "invalid") {
            out.printlnErr(
                suggestEnumFlag("tools claude usage", "--range", RANGE_VALUES, {
                    subcommand: ["usage"],
                    ...(range.given === undefined ? {} : { given: range.given }),
                })
            );
            process.exitCode = 1;
            return;
        }

        if (opts.tui === false || opts.json || opts.token || opts.watch) {
            const { fetchUsage } = await import("@app/claude/lib/usage/api");
            const { getSharedAccountsUsage } = await import("@app/claude/lib/usage/shared-cache");
            const { renderAllAccounts, renderAccountUsage } = await import("@app/claude/lib/usage/display");

            if (opts.token) {
                const usage = await fetchUsage(opts.token);
                const account = { accountName: "token", usage };

                if (opts.json) {
                    out.result(account);
                    await out.flush();
                } else {
                    out.print(renderAccountUsage(account));
                }

                return;
            }

            if (accountFilter) {
                const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
                const aiConfig = await AIConfig.load();
                const known = new Set(aiConfig.getAccountsByProvider("anthropic-sub").map((a) => a.name));
                const unknown = accountFilter.filter((name) => !known.has(name));

                if (unknown.length > 0) {
                    logger.error({ unknown }, "Unknown account");
                    process.exit(1);
                }
            }

            if (opts.watch) {
                // `watchUsage` is the legacy single-account renderer; it takes one name.
                const { watchUsage } = await import("@app/claude/lib/usage/watch");
                await watchUsage(accountFilter?.[0]);
                return;
            }

            const prof = profiler.scope("claude-usage");
            const started = performance.now();
            const results = await prof.measureAsync("shared-cache", () =>
                getSharedAccountsUsage({ accountFilter, force: opts.fresh === true })
            );
            const fetchMs = performance.now() - started;

            if (opts.json) {
                if (opts.scored) {
                    const scoreStarted = performance.now();
                    const { scoreAccounts, sortGrouped } = await import("@app/claude/lib/usage/account-picker");
                    const accounts = sortGrouped(scoreAccounts(results));
                    const timings = {
                        fetchMs,
                        scoreMs: performance.now() - scoreStarted,
                        totalMs: performance.now() - started,
                        accounts: accounts.length,
                    };
                    logger.debug({ timings }, "usage scored timings");
                    prof.summary("usage scored");
                    out.result({ fetchedAt: Date.now(), accounts, timings });
                    await out.flush();
                } else {
                    out.result(results);
                    await out.flush();
                }
            } else {
                out.print(renderAllAccounts(results));
            }

            return;
        }

        // Deferred: ink + react + the TUI tree cost ~160ms to import and the
        // hot --json path (Genesis.app polling) never renders them.
        const { renderUsageTui } = await import("./render-tui");
        await renderUsageTui({
            ...(accountFilter === undefined ? {} : { accountFilter }),
            ...(range.status === "ok" ? { range: range.range } : {}),
        });
    });
}
