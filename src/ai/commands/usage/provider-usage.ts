import { resolveRangeFlag } from "@app/ai/lib/usage/range-flag";
import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { RANGE_VALUES } from "@genesiscz/utils/ink/usage-dashboard/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * `tools <agent> usage`: the shared dashboard pinned to one provider.
 *
 * `src/codex/commands/usage.tsx` and `src/grok/commands/usage.tsx` were byte-identical apart
 * from the provider id, the tool name in the `--range` hint, and the one-line description.
 * Those three are the arguments now. The provider-neutral `tools ai usage` keeps its own
 * richer command: it takes `--provider`, `--no-tui` and `--scored`, which a pinned door cannot.
 */
export interface ProviderUsageOptions {
    /** Plugin id, e.g. `openai-sub`. */
    provider: string;
    /** `tools codex usage`, for the enum-flag hint. */
    tool: string;
    description: string;
}

interface UsageFlags {
    account?: string[];
    range?: string | boolean;
    json?: boolean;
    fresh?: boolean;
}

export function registerProviderUsageCommand(program: Command, options: ProviderUsageOptions): Command {
    return program
        .command("usage")
        .description(options.description)
        .option("--account <name...>", "Limit to these account names")
        .option("--range [value]", `History range: ${RANGE_VALUES.join(" | ")}`)
        .option("--json", "Output the snapshots as JSON instead of opening the TUI")
        .option("--fresh", "Force a live poll, bypassing the shared cache")
        .action(async (flags: UsageFlags) => {
            const range = resolveRangeFlag(flags.range);

            if (range.status === "invalid") {
                out.printlnErr(
                    suggestEnumFlag(options.tool, "--range", RANGE_VALUES, {
                        subcommand: ["usage"],
                        ...(range.given === undefined ? {} : { given: range.given }),
                    })
                );
                process.exitCode = 1;
                return;
            }

            if (flags.json) {
                const accounts = await pollAccounts({
                    providers: [options.provider],
                    ...(flags.account === undefined ? {} : { accountFilter: flags.account }),
                    ...(flags.fresh === undefined ? {} : { force: flags.fresh }),
                });
                out.result({ fetchedAt: new Date().toISOString(), accounts });
                await out.flush();
                return;
            }

            const { renderAiUsageTui } = await import("@app/ai/commands/usage/render-tui");
            await renderAiUsageTui({
                providers: [options.provider],
                ...(flags.account === undefined ? {} : { accountFilter: flags.account }),
                ...(range.status === "ok" ? { range: range.range } : {}),
            });
        });
}
