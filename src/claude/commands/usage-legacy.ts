import { loadConfig } from "@app/claude/lib/config";
import { fetchAllAccountsUsage, fetchUsage } from "@app/claude/lib/usage/api";
import { renderAccountUsage, renderAllAccounts } from "@app/claude/lib/usage/display";
import { watchUsage } from "@app/claude/lib/usage/watch";
import { AIConfig } from "@app/utils/ai/AIConfig";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerUsageLegacyCommand(program: Command): void {
    program
        .command("usage")
        .description("Show Claude API usage and quota")
        .argument("[account]", "Specific account name (default: all configured accounts)")
        .option("--token <token>", "Use a specific OAuth access token")
        .option("--watch", "Watch mode: poll periodically and notify at thresholds")
        .option("--interval <seconds>", "Poll interval in seconds (default: from config)")
        .option("--json", "Output as JSON")
        .action(async (accountArg: string | undefined, opts) => {
            // If --token provided, use it directly
            if (opts.token) {
                const usage = await fetchUsage(opts.token);
                const account = { accountName: "token", usage };

                if (opts.json) {
                    console.log(SafeJSON.stringify(account, null, 2));
                } else {
                    console.log(renderAccountUsage(account));
                }

                return;
            }

            // Resolve accounts from AIConfig
            const aiConfig = await AIConfig.load();
            const allAccounts = aiConfig.getAccountsByProvider("anthropic-sub");

            if (allAccounts.length === 0) {
                p.log.warn("No accounts configured. Run: tools claude login");
                process.exit(1);
            }

            const accountNames = allAccounts.map((a) => a.name);

            // Filter to specific account
            if (accountArg) {
                if (!allAccounts.some((a) => a.name === accountArg)) {
                    p.log.error(`Account "${accountArg}" not found. Available: ${accountNames.join(", ")}`);
                    process.exit(1);
                }
            }

            // Watch mode
            if (opts.watch) {
                const config = await loadConfig();
                const notifConfig = { ...config.notifications };

                if (opts.interval) {
                    const parsed = parseInt(opts.interval, 10);

                    if (Number.isFinite(parsed) && parsed > 0) {
                        notifConfig.watchInterval = parsed;
                    } else {
                        p.log.warn(
                            `Invalid --interval "${opts.interval}", using default ${notifConfig.watchInterval}s.`
                        );
                    }
                }

                await watchUsage(accountArg, notifConfig);
                return;
            }

            // One-shot
            const results = await fetchAllAccountsUsage(accountArg);

            if (opts.json) {
                console.log(SafeJSON.stringify(results, null, 2));
            } else {
                console.log(renderAllAccounts(results));
            }
        });
}
