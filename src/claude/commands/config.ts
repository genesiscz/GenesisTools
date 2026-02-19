import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, saveConfig, type ClaudeConfig } from "../lib/config";
import { getKeychainCredentials, fetchUsage } from "../lib/usage/api";
import { fetchOAuthProfile, getClaudeJsonAccount } from "@app/utils/claude/auth";

async function interactiveConfig(): Promise<void> {
	p.intro(pc.bgCyan(pc.black(" claude config ")));

	const config = await loadConfig();

	while (true) {
		const accountCount = Object.keys(config.accounts).length;
		const action = await p.select({
			message: "What would you like to configure?",
			options: [
				{ value: "accounts", label: `Manage accounts (${accountCount} configured)` },
				{ value: "notifications", label: "Notification settings" },
				{ value: "show", label: "Show current config" },
				{ value: "exit", label: "Exit" },
			],
		});

		if (p.isCancel(action) || action === "exit") {
			p.outro("Done.");
			return;
		}

		if (action === "accounts") {
			await manageAccounts(config);
		} else if (action === "notifications") {
			await manageNotifications(config);
		} else if (action === "show") {
			await showConfig(config);
		}
	}
}

async function manageAccounts(config: ClaudeConfig): Promise<void> {
	const action = await p.select({
		message: "Account action:",
		options: [
			{ value: "add-keychain", label: "Add from Keychain (auto-detect)" },
			{ value: "add-manual", label: "Add with manual token" },
			...(Object.keys(config.accounts).length > 0
				? [{ value: "remove", label: "Remove an account" }]
				: []),
			{ value: "back", label: "Back" },
		],
	});

	if (p.isCancel(action) || action === "back") return;

	if (action === "add-keychain") {
		const spinner = p.spinner();
		spinner.start("Reading Keychain & fetching profile...");
		const kc = await getKeychainCredentials();
		if (!kc) {
			spinner.stop("No credentials found in Keychain.");
			p.log.warn("Make sure you're logged into Claude Code first.");
			return;
		}
		const planLabel = kc.subscriptionType ?? "unknown plan";
		const displayName = kc.account.api?.account.display_name ?? kc.account.claudeJson?.displayName;
		const email = kc.account.api?.account.email ?? kc.account.claudeJson?.emailAddress;
		spinner.stop(`Found: ${pc.cyan(planLabel)}${kc.rateLimitTier ? pc.dim(` (${kc.rateLimitTier})`) : ""}${displayName ? ` — ${pc.green(displayName)}` : ""}`);
		if (email) p.log.info(`Email: ${pc.cyan(email)}`);
		p.log.info(`Token: ${pc.dim(kc.accessToken.slice(0, 20) + "...")}`);

		const name = await p.text({
			message: "Name for this account:",
			placeholder: email?.split("@")[0]?.toLowerCase() ?? "personal",
			validate: (val) => {
				if (!val?.trim()) return "Name is required";
				if (config.accounts[val]) return `Account "${val}" already exists`;
			},
		});
		if (p.isCancel(name)) return;

		const validateSpinner = p.spinner();
		validateSpinner.start("Validating token...");
		try {
			await fetchUsage(kc.accessToken);
			validateSpinner.stop("Token is valid.");
		} catch (err) {
			validateSpinner.stop(`Token validation failed: ${err}`);
			const proceed = await p.confirm({
				message: "Save anyway?",
				initialValue: false,
			});
			if (p.isCancel(proceed) || !proceed) return;
		}

		config.accounts[name as string] = {
			accessToken: kc.accessToken,
			label: kc.subscriptionType,
		};
		if (!config.defaultAccount) config.defaultAccount = name as string;
		await saveConfig(config);
		p.log.success(`Account "${name}" saved.`);
	} else if (action === "add-manual") {
		const name = await p.text({
			message: "Name for this account:",
			placeholder: "work",
			validate: (val) => {
				if (!val?.trim()) return "Name is required";
				if (config.accounts[val]) return `Account "${val}" already exists`;
			},
		});
		if (p.isCancel(name)) return;

		const token = await p.text({
			message: "OAuth access token:",
			validate: (val) => {
				if (!val?.trim()) return "Token is required";
			},
		});
		if (p.isCancel(token)) return;

		const label = await p.text({
			message: "Label (optional, e.g. 'work', 'max'):",
			placeholder: "max",
		});

		config.accounts[name as string] = {
			accessToken: token as string,
			label: p.isCancel(label) ? undefined : (label as string) || undefined,
		};
		if (!config.defaultAccount) config.defaultAccount = name as string;
		await saveConfig(config);
		p.log.success(`Account "${name}" saved.`);
	} else if (action === "remove") {
		const accounts = Object.keys(config.accounts);
		const toRemove = await p.select({
			message: "Remove which account?",
			options: accounts.map((a) => ({
				value: a,
				label: `${a}${config.accounts[a].label ? ` (${config.accounts[a].label})` : ""}`,
			})),
		});
		if (p.isCancel(toRemove)) return;

		const confirmed = await p.confirm({
			message: `Remove account "${toRemove}"?`,
		});
		if (p.isCancel(confirmed) || !confirmed) return;

		delete config.accounts[toRemove as string];
		if (config.defaultAccount === toRemove) {
			config.defaultAccount = Object.keys(config.accounts)[0];
		}
		await saveConfig(config);
		p.log.success(`Account "${toRemove}" removed.`);
	}
}

async function manageNotifications(config: ClaudeConfig): Promise<void> {
	const sessionThresholds = await p.text({
		message: "Session thresholds (comma-separated %):",
		initialValue: config.notifications.sessionThresholds.join(", "),
	});
	if (p.isCancel(sessionThresholds)) return;

	const weeklyThresholds = await p.text({
		message: "Weekly thresholds (comma-separated %):",
		initialValue: config.notifications.weeklyThresholds.join(", "),
	});
	if (p.isCancel(weeklyThresholds)) return;

	const interval = await p.text({
		message: "Watch poll interval (seconds):",
		initialValue: String(config.notifications.watchInterval),
	});
	if (p.isCancel(interval)) return;

	const macosEnabled = await p.confirm({
		message: "Enable macOS notifications?",
		initialValue: config.notifications.channels.macos,
	});
	if (p.isCancel(macosEnabled)) return;

	config.notifications.sessionThresholds = (sessionThresholds as string)
		.split(",")
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => !isNaN(n));
	config.notifications.weeklyThresholds = (weeklyThresholds as string)
		.split(",")
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => !isNaN(n));
	config.notifications.watchInterval = parseInt(interval as string, 10) || 60;
	config.notifications.channels.macos = macosEnabled as boolean;

	await saveConfig(config);
	p.log.success("Notification settings saved.");
}

async function showConfig(config: ClaudeConfig): Promise<void> {
	const accounts = Object.entries(config.accounts);

	const lines = [pc.bold("Accounts:")];

	if (accounts.length === 0) {
		lines.push(pc.dim("  (none configured)"));
	} else {
		const spinner = p.spinner();
		spinner.start("Fetching account profiles...");

		const profiles = await Promise.all(
			accounts.map(async ([, acc]) => fetchOAuthProfile(acc.accessToken)),
		);
		const claudeJson = await getClaudeJsonAccount();

		spinner.stop("Done.");

		for (let i = 0; i < accounts.length; i++) {
			const [name, acc] = accounts[i];
			const profile = profiles[i];
			const isDefault = config.defaultAccount === name;

			lines.push(`  ${pc.bold(name)}${isDefault ? pc.green(" (default)") : ""}`);

			if (profile) {
				lines.push(`    ${pc.dim("API:")} ${profile.account.display_name} <${pc.cyan(profile.account.email)}>`);
				lines.push(`    ${pc.dim("     ")}${profile.organization.organization_type} — ${profile.organization.billing_type} (${profile.organization.rate_limit_tier})`);
				lines.push(`    ${pc.dim("     ")}subscription: ${profile.organization.subscription_status}, extra usage: ${profile.organization.has_extra_usage_enabled ? "enabled" : "disabled"}`);
			} else {
				lines.push(`    ${pc.dim("API:")} ${pc.yellow("unavailable")}`);
			}

			if (claudeJson) {
				lines.push(`    ${pc.dim(".claude.json:")} ${claudeJson.displayName ?? "?"} <${pc.cyan(claudeJson.emailAddress ?? "?")}>`);
				lines.push(`    ${pc.dim("              ")}${claudeJson.billingType ?? "unknown billing"}`);
			}

			lines.push(`    ${pc.dim("Label:")} ${acc.label ?? pc.dim("none")}  ${pc.dim("Token:")} ${pc.dim(acc.accessToken.slice(0, 20) + "...")}`);
			lines.push("");
		}
	}

	lines.push(pc.bold("Notifications:"));
	lines.push(`  Session thresholds: ${config.notifications.sessionThresholds.join(", ")}%`);
	lines.push(`  Weekly thresholds:  ${config.notifications.weeklyThresholds.join(", ")}%`);
	lines.push(`  Watch interval:     ${config.notifications.watchInterval}s`);
	lines.push(`  macOS:              ${config.notifications.channels.macos ? pc.green("enabled") : pc.dim("disabled")}`);

	p.note(lines.join("\n"), "Current Configuration");
}

export function registerConfigCommand(program: Command): void {
	const configCmd = program
		.command("config")
		.description("Manage Claude accounts and notification settings")
		.action(async () => {
			await interactiveConfig();
		});

	configCmd
		.command("add <name>")
		.description("Add an account (reads from Keychain by default)")
		.option("--token <token>", "OAuth access token (instead of Keychain)")
		.action(async (name: string, opts) => {
			const config = await loadConfig();
			if (config.accounts[name]) {
				p.log.error(`Account "${name}" already exists.`);
				process.exit(1);
			}

			let accessToken: string;
			let label: string | undefined;

			if (opts.token) {
				accessToken = opts.token;
			} else {
				const kc = await getKeychainCredentials();
				if (!kc) {
					p.log.error("No credentials found in Keychain. Use --token to provide manually.");
					process.exit(1);
				}
				accessToken = kc.accessToken;
				label = kc.subscriptionType;
				const who = kc.account.api?.account.display_name ?? kc.account.claudeJson?.displayName;
				p.log.info(`Using Keychain credentials: ${pc.cyan(label ?? "unknown plan")}${who ? ` — ${pc.green(who)}` : ""}`);
			}

			config.accounts[name] = { accessToken, label };
			if (!config.defaultAccount) config.defaultAccount = name;
			await saveConfig(config);
			p.log.success(`Account "${name}" added.`);
		});

	configCmd
		.command("remove <name>")
		.description("Remove a configured account")
		.action(async (name: string) => {
			const config = await loadConfig();
			if (!config.accounts[name]) {
				p.log.error(`Account "${name}" not found.`);
				process.exit(1);
			}
			delete config.accounts[name];
			if (config.defaultAccount === name) {
				config.defaultAccount = Object.keys(config.accounts)[0];
			}
			await saveConfig(config);
			p.log.success(`Account "${name}" removed.`);
		});

	configCmd
		.command("show")
		.description("Show current configuration")
		.action(async () => {
			const config = await loadConfig();
			await showConfig(config);
		});
}
