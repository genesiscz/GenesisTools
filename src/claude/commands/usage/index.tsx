import { render } from "ink";
import type { Command } from "commander";
import { App } from "./app";

export function registerUsageCommand(program: Command): void {
    program
        .command("usage")
        .description("Show Claude API usage dashboard (interactive TUI)")
        .argument("[account]", "Specific account name")
        .option("--token <token>", "Use a specific OAuth access token")
        .option("--no-tui", "Use legacy plain text output")
        .option("--json", "Output as JSON")
        .option("--watch", "Watch mode (legacy)")
        .option("--interval <seconds>", "Poll interval override")
        .action(async (accountArg: string | undefined, opts: Record<string, string | boolean | undefined>) => {
            if (opts.tui === false || opts.json || opts.token || opts.watch) {
                const { loadConfig } = await import("@app/claude/lib/config");
                const { fetchAllAccountsUsage, fetchUsage, getKeychainCredentials } =
                    await import("@app/claude/lib/usage/api");
                const { renderAllAccounts, renderAccountUsage } =
                    await import("@app/claude/lib/usage/display");

                if (opts.token && typeof opts.token === "string") {
                    const usage = await fetchUsage(opts.token);
                    const account = { accountName: "token", usage };

                    if (opts.json) {
                        console.log(JSON.stringify(account, null, 2));
                    } else {
                        console.log(renderAccountUsage(account));
                    }

                    return;
                }

                const config = await loadConfig();
                let accounts = config.accounts;

                if (Object.keys(accounts).length === 0) {
                    const kc = await getKeychainCredentials();

                    if (kc) {
                        accounts = {
                            default: {
                                accessToken: kc.accessToken,
                                label: kc.subscriptionType,
                            },
                        };
                    }
                }

                if (accountArg && accounts[accountArg]) {
                    accounts = { [accountArg]: accounts[accountArg] };
                }

                if (opts.watch) {
                    const { watchUsage } = await import("@app/claude/lib/usage/watch");
                    await watchUsage(accounts, config.notifications);
                    return;
                }

                const results = await fetchAllAccountsUsage(accounts);

                if (opts.json) {
                    console.log(JSON.stringify(results, null, 2));
                } else {
                    console.log(renderAllAccounts(results));
                }

                return;
            }

            const { waitUntilExit } = render(<App accountFilter={accountArg} />);
            await waitUntilExit();
        });
}
