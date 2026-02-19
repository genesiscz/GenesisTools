import type { Command } from "commander";
import * as p from "@clack/prompts";
import { loadConfig } from "../lib/config";
import { fetchUsage, fetchAllAccountsUsage, getKeychainCredentials } from "../lib/usage/api";
import { renderAccountUsage, renderAllAccounts } from "../lib/usage/display";
import { watchUsage } from "../lib/usage/watch";

export function registerUsageCommand(program: Command): void {
	program
		.command("usage")
		.description("Show Claude API usage and quota")
		.argument("[account]", "Specific account name (default: all configured accounts)")
		.option("--token <token>", "Use a specific OAuth access token")
		.option("--watch", "Watch mode: poll periodically and notify at thresholds")
		.option("--interval <seconds>", "Poll interval in seconds (default: from config)")
		.option("--json", "Output as JSON")
		.action(async (accountArg: string | undefined, opts) => {
			const config = await loadConfig();

			// If --token provided, use it directly
			if (opts.token) {
				const usage = await fetchUsage(opts.token);
				const account = { accountName: "token", usage };
				if (opts.json) {
					console.log(JSON.stringify(account, null, 2));
				} else {
					console.log(renderAccountUsage(account));
				}
				return;
			}

			// Resolve accounts
			let accounts = config.accounts;
			if (Object.keys(accounts).length === 0) {
				// Try keychain auto-detect
				const kc = await getKeychainCredentials();
				if (kc) {
					accounts = { default: { accessToken: kc.accessToken, email: kc.email } };
				} else {
					p.log.warn("No accounts configured. Run: tools claude config");
					process.exit(1);
				}
			}

			// Filter to specific account
			if (accountArg) {
				if (!accounts[accountArg]) {
					p.log.error(
						`Account "${accountArg}" not found. Available: ${Object.keys(accounts).join(", ")}`,
					);
					process.exit(1);
				}
				accounts = { [accountArg]: accounts[accountArg] };
			}

			// Watch mode
			if (opts.watch) {
				const notifConfig = { ...config.notifications };
				if (opts.interval) notifConfig.watchInterval = parseInt(opts.interval, 10);
				await watchUsage(accounts, notifConfig);
				return;
			}

			// One-shot
			const results = await fetchAllAccountsUsage(accounts);
			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
			} else {
				console.log(renderAllAccounts(results));
			}
		});
}
