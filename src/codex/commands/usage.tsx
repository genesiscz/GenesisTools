import { resolveRangeFlag } from "@app/ai/lib/usage/range-flag";
import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { RANGE_VALUES } from "@genesiscz/utils/ink/usage-dashboard/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface CodexUsageOptions {
    account?: string[];
    range?: string | boolean;
    json?: boolean;
    fresh?: boolean;
}

/**
 * `tools codex usage` is the shared dashboard pinned to `openai-sub`. Codex has no
 * presenter, so the Overview draws the two windows the app-server reports as plain bars.
 */
export function registerUsageCommand(program: Command): void {
    program
        .command("usage")
        .description("Codex rate-limit windows (interactive TUI)")
        .option("--account <name...>", "Limit to these account names")
        .option("--range [value]", `History range: ${RANGE_VALUES.join(" | ")}`)
        .option("--json", "Output the snapshots as JSON instead of opening the TUI")
        .option("--fresh", "Force a live poll, bypassing the shared cache")
        .action(async (opts: CodexUsageOptions) => {
            const range = resolveRangeFlag(opts.range);

            if (range.status === "invalid") {
                out.printlnErr(
                    suggestEnumFlag("tools codex usage", "--range", RANGE_VALUES, {
                        subcommand: ["usage"],
                        ...(range.given === undefined ? {} : { given: range.given }),
                    })
                );
                process.exitCode = 1;
                return;
            }

            if (opts.json) {
                const accounts = await pollAccounts({
                    providers: ["openai-sub"],
                    ...(opts.account === undefined ? {} : { accountFilter: opts.account }),
                    ...(opts.fresh === undefined ? {} : { force: opts.fresh }),
                });
                out.result({ fetchedAt: new Date().toISOString(), accounts });
                await out.flush();
                return;
            }

            const { renderAiUsageTui } = await import("@app/ai/commands/usage/render-tui");
            await renderAiUsageTui({
                providers: ["openai-sub"],
                ...(opts.account === undefined ? {} : { accountFilter: opts.account }),
                ...(range.status === "ok" ? { range: range.range } : {}),
            });
        });
}
