import { renderFullScreen } from "@genesiscz/utils/ink";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { App } from "./app";

export function registerUsageCommand(program: Command): void {
    const usage = program
        .command("usage")
        .description("Show Claude API usage dashboard (interactive TUI)")
        .option("-f, --filter <account>", "Filter to a specific account name")
        .option("--token <token>", "Use a specific OAuth access token")
        .option("--no-tui", "Use legacy plain text output")
        .option("--json", "Output as JSON")
        .option("--scored", "With --json, emit sortGrouped(scoreAccounts(...))")
        .option("--watch", "Watch mode (legacy)")
        .option("--interval <seconds>", "Poll interval override")
        .option("--fresh", "Force a live Anthropic fetch, bypassing the shared cache");

    usage
        .command("sessions")
        .description("List Claude sessions with 1h prompt-cache status as JSON")
        .option("--json", "Output as JSON")
        .option("--hours <n>", "Only sessions with mtime within this many hours", "6")
        .action(async (opts: { json?: boolean; hours?: string }) => {
            const hoursRaw = typeof opts.hours === "string" ? opts.hours : "6";
            const hours = Number.parseInt(hoursRaw, 10);

            if (!Number.isFinite(hours) || hours < 0) {
                logger.error("--hours must be a non-negative integer");
                process.exit(1);
            }

            const { listSessionRowsWithTimings } = await import("@app/claude/lib/usage/session-rows");
            const { rows, timings } = await listSessionRowsWithTimings({ hours, excludeSubagents: true });
            logger.debug({ timings }, "usage sessions timings");
            out.print(SafeJSON.stringify({ fetchedAt: Date.now(), rows, timings }, null, 2));
        });

    usage.action(async (opts: Record<string, string | boolean | undefined>) => {
        const accountFilter = typeof opts.filter === "string" ? opts.filter : undefined;

        if (opts.scored && !opts.json) {
            logger.error("use --json --scored");
            process.exit(1);
        }

        if (opts.tui === false || opts.json || opts.token || opts.watch) {
            const { fetchUsage } = await import("@app/claude/lib/usage/api");
            const { getSharedAccountsUsage } = await import("@app/claude/lib/usage/shared-cache");
            const { renderAllAccounts, renderAccountUsage } = await import("@app/claude/lib/usage/display");

            if (opts.token && typeof opts.token === "string") {
                const usage = await fetchUsage(opts.token);
                const account = { accountName: "token", usage };

                if (opts.json) {
                    out.print(SafeJSON.stringify(account, null, 2));
                } else {
                    out.print(renderAccountUsage(account));
                }

                return;
            }

            // Validate account filter against AIConfig
            if (accountFilter) {
                const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
                const aiConfig = await AIConfig.load();
                const exists = aiConfig.getAccountsByProvider("anthropic-sub").some((a) => a.name === accountFilter);

                if (!exists) {
                    logger.error({ accountFilter }, "Unknown account");
                    process.exit(1);
                }
            }

            if (opts.watch) {
                const { watchUsage } = await import("@app/claude/lib/usage/watch");
                await watchUsage(accountFilter);
                return;
            }

            const started = performance.now();
            const results = await getSharedAccountsUsage({ accountFilter, force: opts.fresh === true });
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
                    out.print(SafeJSON.stringify({ fetchedAt: Date.now(), accounts, timings }, null, 2));
                } else {
                    out.print(SafeJSON.stringify(results, null, 2));
                }
            } else {
                out.print(renderAllAccounts(results));
            }

            return;
        }

        await renderFullScreen(<App accountFilter={accountFilter} />);
    });
}
