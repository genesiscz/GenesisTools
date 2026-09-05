import { runLogin } from "@app/ai/lib/accounts/run-login";
import { type ClaudeConfig, DEFAULT_WARMUP, loadConfig, updateConfig } from "@app/claude/lib/config";
import { partialRenameAdvice, renameClaudeAccount, resolveRenameTo } from "@app/claude/lib/rename-account";
import { fetchUsage } from "@app/claude/lib/usage/api";
import { clearPollGate } from "@app/claude/lib/usage/poll-gate";
import { ensureSubscriptionAnchors, planAllowsClaudeCode } from "@app/claude/lib/usage/subscription";
import { formatWarmupViaHint } from "@app/claude/lib/warmup/service";
import * as p from "@clack/prompts";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { fetchOAuthProfile, getClaudeJsonAccount } from "@genesiscz/utils/claude/auth";
import { LONG_TOKEN_MIN_LENGTH } from "@genesiscz/utils/claude/token-verify";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { formatLocalDate } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

function maskToken(token: string): string {
    if (token.length < 32) {
        return "****";
    }
    return `${token.slice(0, 20)}...`;
}

async function interactiveConfig(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" claude config ")));

    const config = await loadConfig();
    let aiConfig = await AIConfig.load();

    while (true) {
        const accounts = aiConfig.getAccountsByProvider("anthropic-sub");
        const action = await p.select({
            message: "What would you like to configure?",
            options: [
                { value: "accounts", label: `Manage accounts (${accounts.length} configured)` },
                { value: "notifications", label: "Notification settings" },
                { value: "warmup", label: "Auto-warmup" },
                { value: "show", label: "Show current config" },
                { value: "exit", label: "Exit" },
            ],
        });

        if (p.isCancel(action) || action === "exit") {
            p.outro("Done.");
            return;
        }

        if (action === "accounts") {
            await manageAccounts(aiConfig);
            // `AIConfig.invalidate()` drops the STATIC cache; this loop still
            // holds the instance it loaded before the login, so the next screen
            // would render the pre-login account list (PR #360 review t8).
            aiConfig = await AIConfig.load();
        } else if (action === "notifications") {
            await manageNotifications(config);
        } else if (action === "warmup") {
            await manageWarmup(config, aiConfig);
        } else if (action === "show") {
            await showConfig(config, aiConfig);
        }
    }
}

async function manageAccounts(aiConfig: AIConfig): Promise<void> {
    const accounts = aiConfig.getAccountsByProvider("anthropic-sub");

    const action = await p.select({
        message: "Account action:",
        options: [
            { value: "add-oauth", label: "Login with OAuth (recommended)" },
            { value: "add-manual", label: "Add with manual token" },
            ...(accounts.length > 0 ? [{ value: "remove", label: "Remove an account" }] : []),
            { value: "back", label: "Back" },
        ],
    });

    if (p.isCancel(action) || action === "back") {
        return;
    }

    if (action === "add-oauth") {
        // `promptName`: this menu asked what to call the account before the flows
        // moved into the shared lib, and losing that left the interactive path
        // unable to name an account at all (gap/cli).
        await runLogin({ provider: "anthropic-sub", tool: "tools claude login", promptName: true });
        // The shared lib writes through the v4 store, which this menu's in-memory
        // v3 view cannot see; re-read before the next screen renders a stale list.
        AIConfig.invalidate();
    } else if (action === "add-manual") {
        const name = await p.text({
            message: "Name for this account:",
            placeholder: "work",
            validate: (val) => {
                if (!val?.trim()) {
                    return "Name is required";
                }
                if (aiConfig.getAccount(val)) {
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

        const accountLabel = p.isCancel(label) ? undefined : (label as string) || undefined;
        const accountName = name as string;
        const accountToken = token as string;

        await aiConfig.addAccountWithDefaults({
            name: accountName,
            provider: "anthropic-sub",
            tokens: { accessToken: accountToken },
            label: accountLabel,
            apps: ["claude", "ask"],
        });

        p.log.success(`Account "${name}" saved.`);
    } else if (action === "remove") {
        const toRemove = await p.select({
            message: "Remove which account?",
            options: accounts.map((acc) => ({
                value: acc.name,
                label: `${acc.name}${acc.label ? ` (${acc.label})` : ""}`,
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

        await aiConfig.removeAccount(toRemove as string);
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

    const parsedSessionThresholds = (sessionThresholds as string)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 100);
    const parsedWeeklyThresholds = (weeklyThresholds as string)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 100);
    const parsedInterval = parseInt(interval as string, 10);
    const resolvedInterval = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 60;
    const resolvedMacos = macosEnabled as boolean;

    const updated = await updateConfig((cfg) => {
        cfg.notifications.sessionThresholds = parsedSessionThresholds;
        cfg.notifications.weeklyThresholds = parsedWeeklyThresholds;
        cfg.notifications.watchInterval = resolvedInterval;
        cfg.notifications.channels.macos = resolvedMacos;
    });
    Object.assign(config, updated);
    p.log.success("Notification settings saved.");
}

async function manageWarmup(config: ClaudeConfig, aiConfig: AIConfig): Promise<void> {
    if (!config.warmup) {
        config.warmup = structuredClone(DEFAULT_WARMUP);
    }

    const action = await p.select({
        message: "Warmup settings:",
        options: [
            {
                value: "session",
                label: "Session warmup (5h window)",
                hint: config.warmup.session.enabled ? "enabled" : "disabled",
            },
            {
                value: "weekly",
                label: "Weekly reset warmup",
                hint: config.warmup.weekly.enabled ? "enabled" : "disabled",
            },
            { value: "back", label: "Back" },
        ],
    });

    if (p.isCancel(action) || action === "back") {
        return;
    }

    const accounts = aiConfig.getAccountsByProvider("anthropic-sub");

    if (accounts.length === 0) {
        p.log.error("No accounts configured. Run: tools claude login");
        return;
    }

    const accountNames = accounts.map((a) => a.name);

    if (action === "session") {
        await configureSessionWarmup(config, accountNames, aiConfig);
    } else if (action === "weekly") {
        await configureWeeklyWarmup(config, accountNames, aiConfig);
    }
}

async function configureSessionWarmup(config: ClaudeConfig, accountNames: string[], aiConfig: AIConfig): Promise<void> {
    const warmup = config.warmup!;

    const enabled = await p.confirm({
        message: "Enable automatic session warmup?",
        initialValue: warmup.session.enabled,
    });
    if (p.isCancel(enabled)) {
        return;
    }

    if (!enabled) {
        const updated = await updateConfig((cfg) => {
            cfg.warmup!.session.enabled = false;
        });
        Object.assign(config, updated);
        p.log.success("Session warmup disabled.");
        return;
    }

    warmup.session.enabled = enabled;

    // Account selection (multiselect)
    const accounts = await p.multiselect({
        message: "Which accounts to warm up?",
        options: accountNames.map((name) => ({
            value: name,
            label: `${name}${aiConfig.getAccount(name)?.label ? ` (${aiConfig.getAccount(name)?.label})` : ""}`,
        })),
        initialValues: warmup.session.accounts.filter((a) => accountNames.includes(a)),
        required: true,
    });
    if (p.isCancel(accounts)) {
        return;
    }

    warmup.session.accounts = accounts as string[];

    // Schedule
    const startHour = await p.text({
        message: "Start hour (0-23):",
        initialValue: String(warmup.session.schedule.startHour),
        validate: (v = "") => {
            const n = parseInt(v, 10);
            if (Number.isNaN(n) || n < 0 || n > 23) {
                return "Must be 0-23";
            }
        },
    });
    if (p.isCancel(startHour)) {
        return;
    }

    const endHour = await p.text({
        message: "End hour (1-24, last warmup at this hour minus 5):",
        initialValue: String(warmup.session.schedule.endHour),
        validate: (v = "") => {
            const n = parseInt(v, 10);
            if (Number.isNaN(n) || n < 1 || n > 24) {
                return "Must be 1-24";
            }
        },
    });
    if (p.isCancel(endHour)) {
        return;
    }

    const start = parseInt(startHour as string, 10);
    const end = parseInt(endHour as string, 10);
    warmup.session.schedule = { startHour: start, endHour: end };

    // Preview 5h blocks
    const blocks: string[] = [];
    let cursor = start;
    while (cursor + 5 <= end) {
        blocks.push(`${String(cursor).padStart(2, "0")}:00\u2192${String(cursor + 5).padStart(2, "0")}:00`);
        cursor += 5;
    }

    if (blocks.length > 0) {
        p.note(blocks.join(", "), "5h warmup blocks");
    }

    // Notification preferences
    const notify = await p.confirm({
        message: "Notify on each warmup?",
        initialValue: warmup.session.notify,
    });
    if (p.isCancel(notify)) {
        return;
    }

    warmup.session.notify = notify;

    let resolvedNotifyOnlyIfUnused = warmup.session.notifyOnlyIfUnused;

    if (notify) {
        const onlyIfUnused = await p.confirm({
            message: "Only notify if session was unused?",
            initialValue: warmup.session.notifyOnlyIfUnused,
        });
        if (p.isCancel(onlyIfUnused)) {
            return;
        }

        resolvedNotifyOnlyIfUnused = onlyIfUnused;
    }

    const sessionAccounts = warmup.session.accounts;
    const updated = await updateConfig((cfg) => {
        cfg.warmup!.session.enabled = true;
        cfg.warmup!.session.accounts = sessionAccounts;
        cfg.warmup!.session.schedule = { startHour: start, endHour: end };
        cfg.warmup!.session.notify = notify;
        cfg.warmup!.session.notifyOnlyIfUnused = resolvedNotifyOnlyIfUnused;
    });
    Object.assign(config, updated);

    const accountList = sessionAccounts.join(", ");
    p.log.success(
        `Session warmup enabled for ${accountList}. Blocks: ${blocks.join(", ")}. ` +
            `I will automatically start sessions within ${start}:00\u2013${end}:00.`
    );
}

async function configureWeeklyWarmup(config: ClaudeConfig, accountNames: string[], aiConfig: AIConfig): Promise<void> {
    const warmup = config.warmup!;

    const enabled = await p.confirm({
        message: "Enable automatic warmup at weekly reset?",
        initialValue: warmup.weekly.enabled,
    });
    if (p.isCancel(enabled)) {
        return;
    }

    if (!enabled) {
        const updated = await updateConfig((cfg) => {
            cfg.warmup!.weekly.enabled = false;
        });
        Object.assign(config, updated);
        p.log.success("Weekly warmup disabled.");
        return;
    }

    warmup.weekly.enabled = enabled;

    const accounts = await p.multiselect({
        message: "Which accounts to warm up at weekly reset?",
        options: accountNames.map((name) => ({
            value: name,
            label: `${name}${aiConfig.getAccount(name)?.label ? ` (${aiConfig.getAccount(name)?.label})` : ""}`,
        })),
        initialValues: warmup.weekly.accounts.filter((a) => accountNames.includes(a)),
        required: true,
    });
    if (p.isCancel(accounts)) {
        return;
    }

    const weeklyAccounts = accounts as string[];

    const notify = await p.confirm({
        message: "Notify on weekly warmup?",
        initialValue: warmup.weekly.notify,
    });
    if (p.isCancel(notify)) {
        return;
    }
    const updated = await updateConfig((cfg) => {
        cfg.warmup!.weekly.enabled = true;
        cfg.warmup!.weekly.accounts = weeklyAccounts;
        cfg.warmup!.weekly.notify = notify;
    });
    Object.assign(config, updated);
    p.log.success(
        `Weekly warmup enabled for ${weeklyAccounts.join(", ")}. ` +
            "I will automatically notify you whenever a weekly session is started."
    );
}

function todayDateString(): string {
    return formatLocalDate(new Date());
}

async function showConfig(config: ClaudeConfig, aiConfig: AIConfig): Promise<void> {
    const accounts = aiConfig.getAccountsByProvider("anthropic-sub");
    const defaultAccount = aiConfig.getDefaultAccount("claude");

    const lines = [pc.bold("Accounts:")];

    if (accounts.length === 0) {
        lines.push(pc.dim("  (none configured)"));
    } else {
        const spinner = p.spinner();
        spinner.start("Fetching account profiles...");

        const profileResults = await Promise.allSettled(
            accounts.map(async (acc) => fetchOAuthProfile(acc.tokens.accessToken ?? ""))
        );
        const profiles = profileResults.map((r) => (r.status === "fulfilled" ? r.value : undefined));
        const claudeJson = await getClaudeJsonAccount();

        spinner.stop("Done.");

        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];
            const profile = profiles[i];
            const isDefault = defaultAccount?.name === acc.name;

            lines.push(`  ${pc.bold(acc.name)}${isDefault ? pc.green(" (default)") : ""}`);

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
                `    ${pc.dim("Label:")} ${acc.label ?? pc.dim("none")}  ${pc.dim("Token:")} ${pc.dim(maskToken(acc.tokens.accessToken ?? ""))}`
            );

            // A missing or truncated setup token means `cc <name>` silently
            // launches on the KEYCHAIN account instead of this one.
            const longLived = acc.tokens.longLivedToken;

            if (!longLived) {
                lines.push(
                    `    ${pc.dim("Launch:")} ${pc.yellow("no long-lived token")} ${pc.dim(`— fix: tools claude login-long ${acc.name}`)}`
                );
            } else if (longLived.length < LONG_TOKEN_MIN_LENGTH) {
                lines.push(
                    `    ${pc.dim("Launch:")} ${pc.red(`token truncated (${longLived.length} chars)`)} ${pc.dim(`— fix: tools claude login-long ${acc.name}`)}`
                );
            }

            if (acc.subscriptionPlan && !planAllowsClaudeCode(acc)) {
                lines.push(
                    `    ${pc.dim("Plan:")} ${pc.red(acc.subscriptionPlan)} ${pc.dim("— cannot run Claude Code")}`
                );
            }

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

    if (config.warmup) {
        const w = config.warmup;
        lines.push("");
        lines.push(pc.bold("Warmup:"));

        // Session
        if (w.session.enabled) {
            const accts = w.session.accounts.join(", ");
            const { startHour, endHour } = w.session.schedule;
            lines.push(`  Session:  ${pc.green("enabled")} (${accts}) \u2014 ${startHour}:00\u2192${endHour}:00`);

            const blocks: string[] = [];
            let cursor = startHour;
            while (cursor + 5 <= endHour) {
                blocks.push(`${String(cursor).padStart(2, "0")}:00\u2192${String(cursor + 5).padStart(2, "0")}:00`);
                cursor += 5;
            }

            if (blocks.length > 0) {
                lines.push(`            Blocks: ${blocks.join(", ")}`);
            }
        } else {
            lines.push(`  Session:  ${pc.dim("disabled")}`);
        }

        // Weekly
        if (w.weekly.enabled) {
            const accts = w.weekly.accounts.join(", ");
            lines.push(`  Weekly:   ${pc.green("enabled")} (${accts})`);
        } else {
            lines.push(`  Weekly:   ${pc.dim("disabled")}`);
        }

        // Today's log
        const today = todayDateString();
        if (w.todayLog.date === today && w.todayLog.events.length > 0) {
            lines.push("  Today's warmups:");
            for (const evt of w.todayLog.events) {
                const icon = evt.success ? pc.green("\u2713") : pc.red("\u2717");
                const via = pc.dim(formatWarmupViaHint(evt.via));
                lines.push(`    ${evt.time}  ${evt.account.padEnd(20)} ${evt.type.padEnd(8)} ${icon}${via}`);
            }
        }
    }

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
            const aiConfig = await AIConfig.load();

            if (aiConfig.getAccount(name)) {
                p.log.error(`Account "${name}" already exists.`);
                process.exit(1);
            }

            if (!opts.token) {
                p.log.error("--token is required. Use `tools claude login` for OAuth with auto-refresh.");
                process.exit(1);
            }

            await aiConfig.addAccountWithDefaults({
                name,
                provider: "anthropic-sub",
                tokens: { accessToken: opts.token },
                apps: ["claude", "ask"],
            });

            p.log.success(`Account "${name}" added.`);
        });

    configCmd
        .command("remove <name>")
        .description("Remove a configured account")
        .action(async (name: string) => {
            const aiConfig = await AIConfig.load();

            if (!aiConfig.getAccount(name)) {
                p.log.error(`Account "${name}" not found.`);
                process.exit(1);
            }

            await aiConfig.removeAccount(name);
            p.log.success(`Account "${name}" removed.`);
        });

    configCmd
        .command("rename <oldName> [newName]")
        .description(
            "Rename an account, carrying its usage history, warmup lists, and defaults across (best-effort per store)"
        )
        .option("--to <newName>", "New account name (required in non-interactive mode)")
        .action(async (oldName: string, newName: string | undefined, opts: { to?: string }) => {
            const aiConfig = await AIConfig.load();

            if (!aiConfig.getAccount(oldName)) {
                p.log.error(`Account "${oldName}" not found.`);
                process.exit(1);
            }

            const resolved = resolveRenameTo({
                positional: newName,
                toFlag: opts.to,
                interactive: isInteractive(),
            });

            let target: string;

            if ("error" in resolved) {
                if (resolved.error === "to-required") {
                    out.error(pc.red("--to is required in non-interactive mode."));
                    out.info(
                        suggestCommand("tools claude config rename", {
                            subcommand: ["config", "rename"],
                            add: ["--to", "<newName>"],
                        })
                    );
                    process.exit(1);
                }

                const typed = await p.text({
                    message: "New name:",
                    placeholder: oldName,
                    defaultValue: oldName,
                });

                if (p.isCancel(typed) || !String(typed).trim()) {
                    p.cancel("Cancelled.");
                    return;
                }

                target = String(typed).trim();
            } else {
                target = resolved.name;
            }

            if (target === oldName) {
                // The prompt defaults to oldName, so accepting it lands here.
                // renameAiAccount does not reject it and would report a rename
                // that never happened.
                p.log.info(`"${oldName}" already has that name; nothing to do.`);
                return;
            }

            if (aiConfig.getAccount(target)) {
                p.log.error(`Account "${target}" already exists.`);
                process.exit(1);
            }

            const moved = await renameClaudeAccount(oldName, target);

            p.log.success(
                `Renamed "${oldName}" → "${target}" (${moved.historyRows} history row${moved.historyRows === 1 ? "" : "s"} moved).`
            );

            if (moved.failed.length > 0) {
                p.log.warn(
                    `The account is renamed, but ${moved.failed.length} secondary store${moved.failed.length === 1 ? "" : "s"} still hold "${oldName}":`
                );

                for (const failure of moved.failed) {
                    out.println(pc.yellow(`  ${failure.step}: ${failure.error}`));
                }

                for (const line of partialRenameAdvice(oldName, target)) {
                    out.println(pc.dim(`  ${line}`));
                }

                process.exitCode = 1;
            }
            out.println(pc.dim("Sessions already running keep reporting the old name until they exit."));
        });

    configCmd
        .command("refresh [name]")
        .description("Re-read the subscription plan from the OAuth profile (all accounts when no name is given)")
        .action(async (name?: string) => {
            const aiConfig = await AIConfig.load();
            const accounts = aiConfig
                .getAccountsByProvider("anthropic-sub")
                .filter((a) => !name || a.name === name)
                // Force a re-read: the automatic pass only refetches every 6h.
                .map((a) => ({ ...a, subscriptionCheckedAt: undefined }));

            if (accounts.length === 0) {
                p.log.error(name ? `Account "${name}" not found.` : "No Claude accounts configured.");
                process.exit(1);
            }

            await ensureSubscriptionAnchors(aiConfig, accounts, { force: true });

            const fresh = await AIConfig.load();

            for (const account of accounts) {
                const stored = fresh.getAccount(account.name);
                const plan = stored?.subscriptionPlan ?? "unknown";
                const status = stored?.subscriptionStatus ?? "unknown";
                const usable = planAllowsClaudeCode(stored ?? {});

                // An account that just came back healthy must not sit out the
                // backoff it earned while it was dead.
                if (usable) {
                    await clearPollGate(account.name);
                }

                out.println(
                    `${usable ? pc.green("●") : pc.red("●")} ${account.name} — ${plan} (${status})${usable ? "" : pc.dim(" — cannot run Claude Code")}`
                );
            }
        });

    configCmd
        .command("show")
        .description("Show current configuration")
        .action(async () => {
            const config = await loadConfig();
            const aiConfig = await AIConfig.load();
            await showConfig(config, aiConfig);
        });

    // OAuth login command (top-level, not under config). A door onto the shared
    // account lib with the provider pinned; `tools ai accounts login --provider
    // claude` reaches the identical code.
    program
        .command("login [name]")
        .description("Login with OAuth to add an account (with auto-refresh)")
        .action(async (name?: string) => {
            await runLogin({ provider: "anthropic-sub", name, tool: "tools claude login", subcommand: ["login"] });
        });
}
