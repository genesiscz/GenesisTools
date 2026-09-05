import { resolveRangeFlag } from "@app/ai/lib/usage/range-flag";
import { PROVIDER_ALIASES, resolveProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { pollAccounts, usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { RANGE_VALUES } from "@genesiscz/utils/ink/usage-dashboard/types";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export interface AiUsageOptions {
    provider?: string[] | boolean;
    account?: string[];
    filter?: string[];
    range?: string | boolean;
    json?: boolean;
    tui?: boolean;
    fresh?: boolean;
    scored?: boolean;
}

/** Aliases plus plugin ids, so `--provider claude` and `--provider anthropic-sub` both work. */
function providerValues(): string[] {
    return [...new Set([...Object.keys(PROVIDER_ALIASES), ...usagePlugins().map((entry) => entry.plugin.id)])].sort();
}

/**
 * `tools ai usage`: the dashboard across every provider that reports quota (spec 7.5).
 * The TUI is the default; `--json` and `--no-tui` stay importable without Ink, which is
 * what keeps a scripted read cheap.
 */
export function registerAiUsageCommand(usage: Command): void {
    usage
        .option("--provider [name...]", `Limit to these providers: ${providerValues().join(" | ")}`)
        .option("--account <name...>", "Limit to these account names")
        .option("-f, --filter <account...>", "Alias of --account, kept for scripts")
        .option("--range [value]", `History range: ${RANGE_VALUES.join(" | ")}`)
        .option("--json", "Output the snapshots as JSON instead of opening the TUI")
        .option("--no-tui", "Print a plain-text summary instead of opening the TUI")
        .option("--fresh", "Force a live poll, bypassing the shared per-provider cache")
        .option("--scored", "Anthropic-only urgency sort; use tools claude usage --json --scored")
        .action(async (opts: AiUsageOptions) => {
            if (opts.scored) {
                logger.error("--scored is anthropic-only. Run: tools claude usage --json --scored");
                process.exitCode = 1;
                return;
            }

            // `--provider` with no value at all is a MISSING enumerated value, not
            // "every provider": the flag absent means all, and the two must not
            // print the same thing (gap/cli).
            const named = Array.isArray(opts.provider) ? opts.provider : [];
            const bareProvider = opts.provider !== undefined && named.length === 0;
            const known = new Set(providerValues());
            const unknown = named.filter((name) => !known.has(name));

            if (bareProvider || unknown.length > 0) {
                out.printlnErr(
                    suggestEnumFlag("tools ai usage", "--provider", providerValues(), {
                        subcommand: ["usage"],
                        ...(unknown[0] === undefined ? {} : { given: unknown[0] }),
                    })
                );
                process.exitCode = 1;
                return;
            }

            const providers = named.length > 0 ? named.map((name) => resolveProviderAlias(name)) : undefined;
            const names = [...(opts.account ?? []), ...(opts.filter ?? [])];
            const accountFilter = names.length > 0 ? names : undefined;
            const range = resolveRangeFlag(opts.range);

            if (range.status === "invalid") {
                out.printlnErr(
                    suggestEnumFlag("tools ai usage", "--range", RANGE_VALUES, {
                        subcommand: ["usage"],
                        ...(range.given === undefined ? {} : { given: range.given }),
                    })
                );
                process.exitCode = 1;
                return;
            }

            if (opts.json || opts.tui === false) {
                const snapshots = await pollAccounts({
                    ...(providers === undefined ? {} : { providers }),
                    ...(accountFilter === undefined ? {} : { accountFilter }),
                    ...(opts.fresh === undefined ? {} : { force: opts.fresh }),
                });

                if (opts.json) {
                    out.result({ fetchedAt: new Date().toISOString(), accounts: snapshots });
                    await out.flush();
                    return;
                }

                for (const snapshot of snapshots) {
                    const windows = snapshot.limits.map((w) => `${w.label} ${w.percentUsed.toFixed(1)}%`).join("  ");
                    // `join` on an empty list is "", not undefined, so `??` never fell
                    // through and an account with no windows printed a bare colon —
                    // indistinguishable from a healthy account at 0% (gap/cli).
                    const status = snapshot.error ?? snapshot.stale?.reason ?? windows;
                    out.println(`${snapshot.provider}/${snapshot.accountName}: ${status || "no windows reported"}`);
                }

                return;
            }

            // Deferred: ink, react and the whole dashboard tree cost ~160ms to import, and
            // the scripted paths above never render them.
            const { renderAiUsageTui } = await import("./render-tui");
            await renderAiUsageTui({
                ...(providers === undefined ? {} : { providers }),
                ...(accountFilter === undefined ? {} : { accountFilter }),
                ...(range.status === "ok" ? { range: range.range } : {}),
            });
        });
}
