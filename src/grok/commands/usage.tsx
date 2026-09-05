import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { parseTimeRange, RANGE_VALUES } from "@genesiscz/utils/ink/usage-dashboard/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface GrokUsageOptions {
    account?: string[];
    range?: string;
    json?: boolean;
    fresh?: boolean;
}

/**
 * `tools grok usage` is the shared dashboard pinned to `grok-sub`. xAI reports one monthly
 * billing credit rather than percentage windows, so the generic block draws it as money.
 */
export function registerUsageCommand(program: Command): void {
    program
        .command("usage")
        .description("Grok monthly billing credit (interactive TUI)")
        .option("--account <name...>", "Limit to these account names")
        .option("--range <window>", `History range: ${RANGE_VALUES.join(" | ")}`)
        .option("--json", "Output the snapshots as JSON instead of opening the TUI")
        .option("--fresh", "Force a live poll, bypassing the shared cache")
        .action(async (opts: GrokUsageOptions) => {
            const range = opts.range === undefined ? undefined : parseTimeRange(opts.range);

            if (opts.range !== undefined && range === null) {
                out.print(suggestEnumFlag("tools grok usage", "--range", RANGE_VALUES));
                process.exitCode = 1;
                return;
            }

            if (opts.json) {
                const accounts = await pollAccounts({
                    providers: ["grok-sub"],
                    ...(opts.account === undefined ? {} : { accountFilter: opts.account }),
                    ...(opts.fresh === undefined ? {} : { force: opts.fresh }),
                });
                out.result({ fetchedAt: new Date().toISOString(), accounts });
                await out.flush();
                return;
            }

            const { renderAiUsageTui } = await import("@app/ai/commands/usage/render-tui");
            await renderAiUsageTui({
                providers: ["grok-sub"],
                ...(opts.account === undefined ? {} : { accountFilter: opts.account }),
                ...(range === null || range === undefined ? {} : { range }),
            });
        });
}
