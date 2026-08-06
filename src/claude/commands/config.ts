import {
    type ClaudeConfig,
    DEFAULT_WARMUP,
    determineAccountLabel,
    loadConfig,
    updateConfig,
} from "@app/claude/lib/config";
import { identityMismatch } from "@app/claude/lib/identity-guard";
import { fetchUsage } from "@app/claude/lib/usage/api";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { invalidateSharedUsage } from "@app/claude/lib/usage/shared-cache";
import { ensureSubscriptionAnchors, planAllowsClaudeCode } from "@app/claude/lib/usage/subscription";
import * as p from "@clack/prompts";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { claudeOAuth, fetchOAuthProfile, getClaudeJsonAccount } from "@genesiscz/utils/claude/auth";
import { LONG_TOKEN_MIN_LENGTH } from "@genesiscz/utils/claude/token-verify";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { formatLocalDate } from "@genesiscz/utils/date";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

function maskToken(token: string): string {
    if (token.length < 32) {
        return "****";
    }
    return `${token.slice(0, 20)}...`;
}

export async function generateAuthUrl(scopes?: string): Promise<string> {
    const spinner = p.spinner();
    spinner.start("Generating authorization URL...");
    const authUrl = await claudeOAuth.startLogin(scopes);
    spinner.stop("Authorization URL ready.");
    return authUrl;
}

/**
 * THROWS `Cancelled` when the user aborts the browser-choice prompt.
 *
 * It returned a boolean before, and a caller that forgot to check it fell
 * straight through to the code prompt — which happened twice while this PR was
 * in review. `claude/index.ts` already maps a `Cancelled` message to a clean
 * exit 0, so throwing makes the abort impossible to ignore instead of relying
 * on every present and future caller remembering to test a return value.
 *
 * The signature IS the regression test: with `Promise<void>` there is no value
 * left to drop. A behavioural test was written and then removed — `mock.module`
 * is process-global in Bun, so stubbing `@clack/prompts` here broke
 * `src/utils/logger/out.test.ts`, which asserts on the REAL clack sentinel.
 */
export async function presentAuthUrl(authUrl: string): Promise<void> {
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

    out.println();
    out.println(`  ${pc.cyan(authUrl)}`);
    out.println();

    // Never copy the URL unasked: whoever already opened it by hand is holding the
    // CODE in their clipboard, and clobbering that costs them the whole round-trip.
    const action = await p.select({
        message: "How do you want to open it?",
        options: [
            { value: "open", label: "Open in browser now" },
            { value: "copy", label: "Copy the URL to my clipboard", hint: "overwrites whatever is in it" },
            { value: "none", label: "Neither — I already have the code", hint: "clipboard untouched" },
        ],
    });

    if (p.isCancel(action)) {
        throw new Error("Cancelled");
    }

    if (action === "open") {
        Bun.spawn(["open", authUrl], { stdio: ["ignore", "ignore", "ignore"] });
    } else if (action === "copy") {
        await copyToClipboard(authUrl, { silent: true });
        p.log.info("URL copied. After authorizing, copy the CODE from the callback page — that is what to paste next.");
    }
}

/**
 * Accept what the user actually has in the clipboard: the bare `code#state`, or
 * the whole callback URL (its `code`/`state` params are pulled out). Declining
 * the browser-open puts the AUTHORIZE url on the clipboard, so that exact
 * mis-paste is caught here instead of failing as "Invalid request format".
 */
export function normalizeAuthorizationCode(input: string): { code: string } | { error: string } {
    const trimmed = input.trim();

    if (!trimmed.startsWith("http")) {
        return { code: trimmed };
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch (error) {
        logger.debug({ error }, "[oauth] pasted value starts with http but is not a parseable URL");
        return { error: "That looks like a URL but could not be parsed. Paste the code shown after authorizing." };
    }

    if (url.pathname.includes("/oauth/authorize")) {
        return {
            error: "That is the authorization URL (what we copied to your clipboard), not the code. Open it, click Authorize, then paste the code from the callback page.",
        };
    }

    const code = url.searchParams.get("code");

    if (!code) {
        return { error: "No `code` parameter in that URL. Paste the code shown after authorizing." };
    }

    const state = url.searchParams.get("state");
    return { code: state ? `${code}#${state}` : code };
}

export async function promptAndExchangeCode(
    opts: { expiresIn?: number } = {}
): Promise<Awaited<ReturnType<typeof claudeOAuth.exchangeCode>> | null> {
    const code = await p.text({
        message: "Paste the authorization code:",
        placeholder: "code#state",
        validate: (val) => {
            if (!val?.trim()) {
                return "Code is required";
            }

            const normalized = normalizeAuthorizationCode(val);
            if ("error" in normalized) {
                return normalized.error;
            }
        },
    });

    if (p.isCancel(code)) {
        return null;
    }

    const normalized = normalizeAuthorizationCode(code as string);

    if ("error" in normalized) {
        p.log.error(normalized.error);
        return null;
    }

    const spinner = p.spinner();
    spinner.start("Exchanging code for tokens...");
    try {
        const tokens = await claudeOAuth.exchangeCode(normalized.code, opts);
        spinner.stop("Tokens received.");
        return tokens;
    } catch (err) {
        spinner.stop(`Token exchange failed: ${err}`);
        return null;
    }
}

export async function fetchAndDisplayProfile(
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

async function promptAccountName(aiConfig: AIConfig, suggestedName: string): Promise<string | null> {
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

    if (aiConfig.getAccount(name as string)) {
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
                    if (aiConfig.getAccount(val)) {
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

async function addAccountViaOAuth(aiConfig: AIConfig): Promise<void> {
    const authUrl = await generateAuthUrl();

    await presentAuthUrl(authUrl);

    const tokens = await promptAndExchangeCode();
    if (!tokens) {
        return;
    }

    const profile = await fetchAndDisplayProfile(tokens);

    const suggestedName = tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "personal";
    const name = await promptAccountName(aiConfig, suggestedName);
    if (!name) {
        return;
    }

    await aiConfig.addAccountWithDefaults({
        name,
        provider: "anthropic-sub",
        tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            refreshExpiresAt: tokens.refreshExpiresAt,
        },
        label: determineAccountLabel(profile),
        apps: ["claude", "ask"],
    });

    p.log.success(`Account "${name}" saved with auto-refresh support.`);
}

async function interactiveConfig(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" claude config ")));

    const config = await loadConfig();
    const aiConfig = await AIConfig.load();

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
        await addAccountViaOAuth(aiConfig);
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
                lines.push(`    ${evt.time}  ${evt.account.padEnd(20)} ${evt.type.padEnd(8)} ${icon}`);
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
        .command("rename <oldName> <newName>")
        .description("Rename an account, carrying its usage history and defaults across")
        .action(async (oldName: string, newName: string) => {
            const aiConfig = await AIConfig.load();

            if (!aiConfig.getAccount(oldName)) {
                p.log.error(`Account "${oldName}" not found.`);
                process.exit(1);
            }

            await aiConfig.renameAccount(oldName, newName);

            // History is keyed by NAME, so it has to move in the same breath or
            // the account's burn pace silently restarts from zero.
            const moved = new UsageHistoryDb().renameAccount(oldName, newName);

            // The shared usage cache is name-keyed too; drop it so the next poll
            // rebuilds it under the new name instead of showing a ghost row.
            await invalidateSharedUsage();

            p.log.success(`Renamed "${oldName}" → "${newName}" (${moved} history row${moved === 1 ? "" : "s"} moved).`);
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

            await ensureSubscriptionAnchors(aiConfig, accounts);

            const fresh = await AIConfig.load();

            for (const account of accounts) {
                const stored = fresh.getAccount(account.name);
                const plan = stored?.subscriptionPlan ?? "unknown";
                const status = stored?.subscriptionStatus ?? "unknown";
                const usable = planAllowsClaudeCode(stored ?? {});

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

    // OAuth login command (top-level, not under config)
    program
        .command("login [name]")
        .description("Login with OAuth to add an account (with auto-refresh)")
        .action(async (name?: string) => {
            const aiConfig = await AIConfig.load();

            // Same helpers the other login paths use: three-way browser choice
            // (so declining never clobbers a clipboard that holds the code) and
            // a paste prompt that accepts the callback URL.
            const authUrl = await generateAuthUrl();

            await presentAuthUrl(authUrl);

            const tokens = await promptAndExchangeCode();

            if (!tokens) {
                out.println(pc.dim("Login cancelled."));
                process.exit(0);
            }

            // Determine account name
            const accountName = name ?? tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "personal";
            if (aiConfig.getAccount(accountName)) {
                out.println(pc.yellow(`Updating existing account "${accountName}"...`));
            }

            // Fetch profile for label
            const profile = await fetchOAuthProfile(tokens.accessToken);
            const label = determineAccountLabel(profile);

            // The browser decided who authorized. If that is a different person
            // than the entry being written, saying yes would overwrite another
            // account's tokens with this identity's.
            const existing = aiConfig.getAccount(accountName);

            if (
                identityMismatch({
                    storedUuid: existing?.secondary?.accountUuid,
                    incomingUuid: profile?.account.uuid,
                })
            ) {
                out.println(
                    pc.yellow(
                        `⚠ This grant belongs to ${profile?.account.email ?? "another account"}, ` +
                            `a DIFFERENT identity than "${accountName}".`
                    )
                );

                const proceed = await p.confirm({ message: "Save anyway?", initialValue: false });

                if (p.isCancel(proceed) || !proceed) {
                    p.cancel("Cancelled — nothing written.");
                    process.exit(0);
                }
            }

            await aiConfig.addAccountWithDefaults({
                name: accountName,
                provider: "anthropic-sub",
                tokens: {
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    expiresAt: tokens.expiresAt,
                    refreshExpiresAt: tokens.refreshExpiresAt,
                },
                label,
                apps: ["claude", "ask"],
            });

            out.println();
            out.println(pc.green(`✓ Account "${accountName}" saved with auto-refresh.`));
            if (tokens.account) {
                out.println(pc.dim(`  Email: ${tokens.account.email}`));
            }
            if (label) {
                out.println(pc.dim(`  Plan: ${label}`));
            }
        });
}
