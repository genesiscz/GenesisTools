import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { render } from "ink";
import { App } from "./app";

export function registerUsageCommand(program: Command): void {
    program
        .command("usage")
        .description("Show Claude API usage dashboard (interactive TUI)")
        .option("-f, --filter <account>", "Filter to a specific account name")
        .option("--token <token>", "Use a specific OAuth access token")
        .option("--no-tui", "Use legacy plain text output")
        .option("--json", "Output as JSON")
        .option("--watch", "Watch mode (legacy)")
        .option("--interval <seconds>", "Poll interval override")
        .action(async (opts: Record<string, string | boolean | undefined>) => {
            const accountFilter = typeof opts.filter === "string" ? opts.filter : undefined;

            if (opts.tui === false || opts.json || opts.token || opts.watch) {
                const { loadConfig } = await import("@app/claude/lib/config");
                const { fetchAllAccountsUsage, fetchUsage } = await import("@app/claude/lib/usage/api");
                const { renderAllAccounts, renderAccountUsage } = await import("@app/claude/lib/usage/display");

                if (opts.token && typeof opts.token === "string") {
                    const usage = await fetchUsage(opts.token);
                    const account = { accountName: "token", usage };

                    if (opts.json) {
                        console.log(SafeJSON.stringify(account, null, 2));
                    } else {
                        console.log(renderAccountUsage(account));
                    }

                    return;
                }

                const config = await loadConfig();
                let accounts = config.accounts;

                if (accountFilter) {
                    if (!accounts[accountFilter]) {
                        console.error(`Unknown account: ${accountFilter}`);
                        process.exit(1);
                    }

                    accounts = { [accountFilter]: accounts[accountFilter] };
                }

                if (opts.watch) {
                    const { watchUsage } = await import("@app/claude/lib/usage/watch");
                    await watchUsage(accounts, config.notifications);
                    return;
                }

                const results = await fetchAllAccountsUsage(accounts);

                if (opts.json) {
                    console.log(SafeJSON.stringify(results, null, 2));
                } else {
                    console.log(renderAllAccounts(results));
                }

                return;
            }

            const { waitUntilExit } = render(<App accountFilter={accountFilter} />);
            await waitUntilExit();
        });
}
