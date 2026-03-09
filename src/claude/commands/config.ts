import { type ClaudeConfig, determineAccountLabel, loadConfig, saveConfig } from "@app/claude/lib/config";
import { fetchUsage } from "@app/claude/lib/usage/api";
import { claudeOAuth, fetchOAuthProfile, getClaudeJsonAccount } from "@app/utils/claude/auth";
import { copyToClipboard } from "@app/utils/clipboard";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

function maskToken(token: string): string {
    if (token.length < 32) {
        return "****";
    }
    return `${token.slice(0, 20)}...`;
}


async function generateAuthUrl(): Promise<string> {
    const spinner = p.spinner();
    spinner.start("Generating authorization URL...");
    const authUrl = await claudeOAuth.startLogin();
    spinner.stop("Authorization URL ready.");
    return authUrl;
}

async function presentAuthUrl(authUrl: string): Promise<void> {
    p.note(
        [
            "1. Open the URL below in your browser",
            "2. Log in with your Claude account (if needed)",
            "3. Click 'Authorize' to grant access",
            "4. Copy the code shown on the callback page",
            "   (format: code#state or just the code part)",
        ].join("\n"),
        "OAuth Login"
    );

    console.log();
    console.log(`  ${pc.cyan(authUrl)}`);
    console.log();

    const openBrowser = await p.confirm({
        message: "Open URL in browser?",
        initialValue: true,
    });

    if (p.isCancel(openBrowser)) {
        return;
    }

    if (openBrowser) {
        Bun.spawn(["open", authUrl], { stdio: ["ignore", "ignore", "ignore"] });
    } else {
        await copyToClipboard(authUrl, { silent: true });
        p.log.info("URL copied to clipboard.");
    }
}

async function promptAndExchangeCode(): Promise<Awaited<ReturnType<typeof claudeOAuth.exchangeCode>> | null> {
    const code = await p.text({
        message: "Paste the authorization code:",
        placeholder: "code#state",
        validate: (val) => {
            if (!val?.trim()) {
                return "Code is required";
            }
        },
    });

    if (p.isCancel(code)) {
        return null;
    }

    const spinner = p.spinner();
    spinner.start("Exchanging code for tokens...");
    try {
        const tokens = await claudeOAuth.exchangeCode(code as string);
        spinner.stop("Tokens received.");
        return tokens;
    } catch (err) {
        spinner.stop(`Token exchange failed: ${err}`);
        return null;
    }
}

async function fetchAndDisplayProfile(
    tokens: Awaited<ReturnType<typeof claudeOAuth.exchangeCode>>
): Promise<Awaited<ReturnType<typeof fetchOAuthProfile>>> {
    const spinner = p.spinner();
    spinner.start("Fetching account profile...");
    const profile = await fetchOAuthProfile(tokens.accessToken);
    spinner.stop("Profile fetched.");

    const infoLines: string[] = [];

    if (tokens.account) {
        infoLines.push(`${pc.dim("Account:")} ${pc.cyan(tokens.account.email)}`);
    }

    if (tokens.organization) {
        infoLines.push(`${pc.dim("Organization:")} ${tokens.organization.name}`);
    }

    if (profile) {
        const sub = profile.organization.subscription_status;
        const tier = profile.organization.rate_limit_tier;
        infoLines.push(`${pc.dim("Subscription:")} ${sub} (${tier})`);
    }

    infoLines.push(`${pc.dim("Scopes:")} ${tokens.scopes.join(", ")}`);
    infoLines.push(`${pc.dim("Expires:")} ${new Date(tokens.expiresAt).toLocaleString()}`);
    infoLines.push(`${pc.dim("Refresh:")} ${pc.green("available")} — token will auto-refresh`);

    p.note(infoLines.join("\n"), "Account Authorized");
    return profile;
}

async function promptAccountName(config: ClaudeConfig, suggestedName: string): Promise<string | null> {
    let name = await p.text({
        message: "Name for this account:",
        placeholder: suggestedName,
        validate: (val) => {
            if (!val?.trim()) {
                return "Name is required";
            }
        },
    });

    if (p.isCancel(name)) {
        return null;
    }

    if (config.accounts[name as string]) {
        const overwrite = await p.confirm({
            message: `Account "${name}" already exists. Overwrite?`,
            initialValue: false,
        });

        if (p.isCancel(overwrite) || !overwrite) {
            name = await p.text({
                message: "Enter a different name:",
                validate: (val) => {
                    if (!val?.trim()) {
                        return "Name is required";
                    }
                    if (config.accounts[val]) {
                        return `Account "${val}" already exists`;
                    }
                },
            });

            if (p.isCancel(name)) {
                return null;
            }
        }
    }

    return name as string;
}

async function addAccountViaOAuth(config: ClaudeConfig): Promise<void> {
    const authUrl = await generateAuthUrl();
    await presentAuthUrl(authUrl);

    const tokens = await promptAndExchangeCode();
    if (!tokens) {
        return;
    }

    const profile = await fetchAndDisplayProfile(tokens);

    const suggestedName = tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "personal";
    const name = await promptAccountName(config, suggestedName);
    if (!name) {
        return;
    }

    config.accounts[name] = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        label: determineAccountLabel(profile),
    };

    if (!config.defaultAccount) {
        config.defaultAccount = name;
    }

    await saveConfig(config);
    p.log.success(`Account "${name}" saved with auto-refresh support.`);
}

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
            { value: "add-oauth", label: "Login with OAuth (recommended)" },
            { value: "add-manual", label: "Add with manual token" },
            ...(Object.keys(config.accounts).length > 0 ? [{ value: "remove", label: "Remove an account" }] : []),
            { value: "back", label: "Back" },
        ],
    });

    if (p.isCancel(action) || action === "back") {
        return;
    }

    if (action === "add-oauth") {
        await addAccountViaOAuth(config);
    } else if (action === "add-manual") {
        const name = await p.text({
            message: "Name for this account:",
            placeholder: "work",
            validate: (val) => {
                if (!val?.trim()) {
                    return "Name is required";
                }
                if (config.accounts[val]) {
                    return `Account "${val}" already exists`;
                }
            },
        });
        if (p.isCancel(name)) {
            return;
        }

        const token = await p.text({
            message: "OAuth access token:",
            validate: (val) => {
                if (!val?.trim()) {
                    return "Token is required";
                }
            },
        });
        if (p.isCancel(token)) {
            return;
        }

        const validateSpinner = p.spinner();
        validateSpinner.start("Validating token...");
        try {
            await fetchUsage(token as string);
            validateSpinner.stop("Token is valid.");
        } catch (err) {
            validateSpinner.stop(`Token validation failed: ${err}`);
            const proceed = await p.confirm({
                message: "Save anyway?",
                initialValue: false,
            });
            if (p.isCancel(proceed) || !proceed) {
                return;
            }
        }

        const label = await p.text({
            message: "Label (optional, e.g. 'work', 'max'):",
            placeholder: "max",
        });

        config.accounts[name as string] = {
            accessToken: token as string,
            label: p.isCancel(label) ? undefined : (label as string) || undefined,
        };
        if (!config.defaultAccount) {
            config.defaultAccount = name as string;
        }
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
        if (p.isCancel(toRemove)) {
            return;
        }

        const confirmed = await p.confirm({
            message: `Remove account "${toRemove}"?`,
        });
        if (p.isCancel(confirmed) || !confirmed) {
            return;
        }

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
    if (p.isCancel(sessionThresholds)) {
        return;
    }

    const weeklyThresholds = await p.text({
        message: "Weekly thresholds (comma-separated %):",
        initialValue: config.notifications.weeklyThresholds.join(", "),
    });
    if (p.isCancel(weeklyThresholds)) {
        return;
    }

    const interval = await p.text({
        message: "Watch poll interval (seconds):",
        initialValue: String(config.notifications.watchInterval),
    });
    if (p.isCancel(interval)) {
        return;
    }

    const macosEnabled = await p.confirm({
        message: "Enable macOS notifications?",
        initialValue: config.notifications.channels.macos,
    });
    if (p.isCancel(macosEnabled)) {
        return;
    }

    config.notifications.sessionThresholds = (sessionThresholds as string)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 100);
    config.notifications.weeklyThresholds = (weeklyThresholds as string)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 100);
    const parsedInterval = parseInt(interval as string, 10);
    config.notifications.watchInterval = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 60;
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

        const profileResults = await Promise.allSettled(
            accounts.map(async ([, acc]) => fetchOAuthProfile(acc.accessToken))
        );
        const profiles = profileResults.map((r) => (r.status === "fulfilled" ? r.value : undefined));
        const claudeJson = await getClaudeJsonAccount();

        spinner.stop("Done.");

        for (let i = 0; i < accounts.length; i++) {
            const [name, acc] = accounts[i];
            const profile = profiles[i];
            const isDefault = config.defaultAccount === name;

            lines.push(`  ${pc.bold(name)}${isDefault ? pc.green(" (default)") : ""}`);

            if (profile) {
                lines.push(`    ${pc.dim("API:")} ${profile.account.display_name} <${pc.cyan(profile.account.email)}>`);
                lines.push(
                    `    ${pc.dim("     ")}${profile.organization.organization_type} — ${profile.organization.billing_type} (${profile.organization.rate_limit_tier})`
                );
                lines.push(
                    `    ${pc.dim("     ")}subscription: ${profile.organization.subscription_status}, extra usage: ${profile.organization.has_extra_usage_enabled ? "enabled" : "disabled"}`
                );
            } else {
                lines.push(`    ${pc.dim("API:")} ${pc.yellow("unavailable")}`);
            }

            if (claudeJson) {
                lines.push(
                    `    ${pc.dim(".claude.json:")} ${claudeJson.displayName ?? "?"} <${pc.cyan(claudeJson.emailAddress ?? "?")}>`
                );
                lines.push(`    ${pc.dim("              ")}${claudeJson.billingType ?? "unknown billing"}`);
            }

            lines.push(
                `    ${pc.dim("Label:")} ${acc.label ?? pc.dim("none")}  ${pc.dim("Token:")} ${pc.dim(maskToken(acc.accessToken))}`
            );
            lines.push("");
        }
    }

    lines.push(pc.bold("Notifications:"));
    lines.push(`  Session thresholds: ${config.notifications.sessionThresholds.join(", ")}%`);
    lines.push(`  Weekly thresholds:  ${config.notifications.weeklyThresholds.join(", ")}%`);
    lines.push(`  Watch interval:     ${config.notifications.watchInterval}s`);
    lines.push(
        `  macOS:              ${config.notifications.channels.macos ? pc.green("enabled") : pc.dim("disabled")}`
    );

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
        .description("Add an account with a manual token (use `tools claude login` for OAuth)")
        .option("--token <token>", "OAuth access token")
        .action(async (name: string, opts: { token?: string }) => {
            const config = await loadConfig();
            if (config.accounts[name]) {
                p.log.error(`Account "${name}" already exists.`);
                process.exit(1);
            }

            if (!opts.token) {
                p.log.error("--token is required. Use `tools claude login` for OAuth with auto-refresh.");
                process.exit(1);
            }

            config.accounts[name] = { accessToken: opts.token };
            if (!config.defaultAccount) {
                config.defaultAccount = name;
            }
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

    // OAuth login command (top-level, not under config)
    program
        .command("login [name]")
        .description("Login with OAuth to add an account (with auto-refresh)")
        .action(async (name?: string) => {
            const config = await loadConfig();

            // Generate auth URL
            console.log(pc.dim("Generating authorization URL..."));
            const authUrl = await claudeOAuth.startLogin();

            console.log();
            console.log(pc.bold("OAuth Login"));
            console.log(pc.dim("─".repeat(50)));
            console.log();
            console.log("1. Open this URL in your browser:");
            console.log();
            console.log(`   ${pc.cyan(authUrl)}`);
            console.log();
            console.log("2. Log in and click 'Authorize'");
            console.log("3. Copy the code from the callback page");
            console.log();
            console.log(pc.dim("─".repeat(50)));

            // Open browser
            Bun.spawn(["open", authUrl], { stdio: ["ignore", "ignore", "ignore"] });
            console.log(pc.dim("(Opening browser...)"));
            console.log();

            // Read code from stdin
            process.stdout.write("Paste authorization code: ");
            const reader = Bun.stdin.stream().getReader();
            let value: Uint8Array | undefined;
            try {
                const result = await reader.read();
                value = result.value;
            } finally {
                reader.releaseLock();
            }
            const code = new TextDecoder().decode(value ?? new Uint8Array()).trim();

            if (!code) {
                console.error(pc.red("No code provided."));
                process.exit(1);
            }

            // Exchange code
            console.log(pc.dim("Exchanging code for tokens..."));
            let tokens: Awaited<ReturnType<typeof claudeOAuth.exchangeCode>>;
            try {
                tokens = await claudeOAuth.exchangeCode(code);
            } catch (err) {
                console.error(pc.red(`Token exchange failed: ${err}`));
                process.exit(1);
            }

            // Determine account name
            const accountName = name ?? tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "personal";
            if (config.accounts[accountName]) {
                console.log(pc.yellow(`Updating existing account "${accountName}"...`));
            }

            // Fetch profile for label
            const profile = await fetchOAuthProfile(tokens.accessToken);
            const label = determineAccountLabel(profile);

            // Save
            config.accounts[accountName] = {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
                label,
            };
            if (!config.defaultAccount) {
                config.defaultAccount = accountName;
            }
            await saveConfig(config);

            console.log();
            console.log(pc.green(`✓ Account "${accountName}" saved with auto-refresh.`));
            if (tokens.account) {
                console.log(pc.dim(`  Email: ${tokens.account.email}`));
            }
            if (label) {
                console.log(pc.dim(`  Plan: ${label}`));
            }
        });
}
