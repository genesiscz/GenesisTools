import { homedir } from "node:os";
import { join } from "node:path";
import { type LaunchableModel, modelFamilyOf, resolveModelSpec } from "@app/claude/lib/models";
import { type ScoredAccount, scoreAccounts } from "@app/claude/lib/usage/account-picker";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
import { logger, out } from "@app/logger";
import { AIConfig } from "@app/utils/ai/AIConfig";
import { findClaudeCommand } from "@app/utils/claude";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import type { AIAccountEntry } from "@app/utils/config/ai.types";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { finishKeychainSession, injectSecondaryLogin, inspectKeychainBeforeInject } from "../lib/keychain-session";
import { pickSessionForResume } from "./resume";

const CLAUDE_JSON = join(homedir(), ".claude.json");

interface StartOptions {
    pick?: boolean;
    autopick?: boolean;
    model?: string;
    resume?: string | boolean;
    continue?: boolean;
    keychain?: boolean;
}

/**
 * Claude Code's interactive onboarding ignores CLAUDE_CODE_OAUTH_TOKEN and shows
 * the OAuth login screen when hasCompletedOnboarding is false (e.g. after /logout).
 * See anthropics/claude-code#8938, #46259 — token auth works once onboarding is skipped.
 */
async function ensureOnboardingSkippedForOAuthToken(): Promise<void> {
    // Best-effort by contract: any fs/parse failure here (permissions, disk, foreign
    // ~/.claude.json) must log and return — never abort the actual claude launch.
    try {
        const file = Bun.file(CLAUDE_JSON);
        if (!(await file.exists())) {
            return;
        }

        const text = await file.text();
        if (/"hasCompletedOnboarding"\s*:\s*true/.test(text)) {
            return;
        }

        let updated = text;
        if (/"hasCompletedOnboarding"\s*:\s*false/.test(text)) {
            updated = text.replace(/"hasCompletedOnboarding"\s*:\s*false/, '"hasCompletedOnboarding": true');
        } else {
            const config = SafeJSON.parse(text, { strict: true }) as Record<string, unknown>;
            config.hasCompletedOnboarding = true;
            updated = SafeJSON.stringify(config, null, 2);
        }

        await Bun.write(CLAUDE_JSON, updated);
        logger.debug({ path: CLAUDE_JSON }, "Set hasCompletedOnboarding for CLAUDE_CODE_OAUTH_TOKEN launch");
    } catch (error) {
        logger.warn({ error, path: CLAUDE_JSON }, "Could not patch hasCompletedOnboarding in ~/.claude.json");
    }
}

function shellQuote(arg: string): string {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function modelOption(model: LaunchableModel) {
    return { value: model.id, label: model.id, hint: model.label };
}

/** Resolve a --model spec to an exact id, showing a filter-picker on multiple matches. */
async function resolveModel(spec: string): Promise<string> {
    const resolution = resolveModelSpec(spec);

    if (resolution.kind === "none") {
        out.error(pc.red(`No Claude model matches "${spec}".`));
        out.printlnErr(pc.dim("Try: fable, opus, sonnet, haiku, 4.8, opus 1m, claude-opus-4-8[1m], ..."));
        await out.flush();
        process.exit(1);
    }

    if (resolution.kind === "exact") {
        return resolution.model.id;
    }

    if (!isInteractive()) {
        out.error(pc.red(`Model "${spec}" is ambiguous in non-interactive mode.`));
        out.printlnErr(pc.dim(`Matches: ${resolution.candidates.map((m) => m.id).join(", ")}`));
        await out.flush();
        process.exit(1);
    }

    const picked = await p.select({
        message: `Model matching "${spec}":`,
        options: resolution.candidates.map(modelOption),
    });

    if (p.isCancel(picked)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return picked as string;
}

const TIER_BADGE: Record<ScoredAccount["tier"], string> = {
    ready: pc.green("●"),
    "session-starved": pc.yellow("◐"),
    "weekly-blocked": pc.red("○"),
    "no-data": pc.dim("?"),
};

async function scoreTokenAccounts(
    withToken: AIAccountEntry[],
    modelId: string | undefined
): Promise<ScoredAccount[] | null> {
    const spinner = p.spinner();
    spinner.start("Checking usage across accounts...");

    try {
        const usage = await getSharedAccountsUsage({ accountFilter: withToken.map((a) => a.name) });
        if (usage.length === 0) {
            spinner.stop(pc.yellow("No usage data available"));
            return null;
        }

        const scored = scoreAccounts(usage, {
            modelFamily: modelId ? modelFamilyOf(modelId) : undefined,
        });
        spinner.stop(`Ranked ${scored.length} account${scored.length === 1 ? "" : "s"} by usage headroom`);
        return scored;
    } catch (error) {
        spinner.stop(pc.yellow("Usage check failed"));
        logger.warn({ error }, "Account scoring failed, falling back to plain selection");
        return null;
    }
}

function scoredHint(account: ScoredAccount): string {
    return account.dataNote ? `${account.why} ${pc.yellow(`[${account.dataNote}]`)}` : account.why;
}

/** Plain alphabetical select — fallback when usage data is unavailable. */
async function plainSelect(withToken: AIAccountEntry[], defaultName: string): Promise<string> {
    const picked = await p.select({
        message: "Launch Claude Code as which account?",
        initialValue: defaultName,
        options: withToken.map((acc) => ({
            value: acc.name,
            label: acc.label ? `${acc.name} ${pc.dim(`(${acc.label})`)}` : acc.name,
        })),
    });

    if (p.isCancel(picked)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return picked as string;
}

async function pickAccount(
    withToken: AIAccountEntry[],
    opts: StartOptions,
    modelId: string | undefined,
    aiConfig: AIConfig
): Promise<string> {
    if (withToken.length === 1 && !opts.pick && !opts.autopick) {
        return withToken[0].name;
    }

    if (!opts.autopick && !isInteractive()) {
        out.error(pc.red("Account name required in non-interactive mode (or use --autopick)."));
        out.printlnErr(suggestCommand("tools claude start", { add: ["--autopick"] }));
        await out.flush();
        process.exit(1);
    }

    const scored = await scoreTokenAccounts(withToken, modelId);

    if (opts.autopick) {
        if (!scored) {
            out.error(pc.red("Cannot autopick: usage data unavailable."));
            await out.flush();
            process.exit(1);
        }

        const best = scored[0];
        if (best.tier === "no-data") {
            out.printlnErr(pc.yellow("No account has usage data; picking the first configured account."));
        }

        out.printlnErr(`${TIER_BADGE[best.tier]} ${pc.cyan(best.accountName)} — ${scoredHint(best)}`);

        const runnerUp = scored[1];
        if (runnerUp) {
            out.printlnErr(pc.dim(`  vs ${runnerUp.accountName} — ${runnerUp.why}`));
        }

        return best.accountName;
    }

    if (!scored) {
        const defaultAccount = aiConfig.getDefaultAccount("claude");
        const defaultName =
            defaultAccount && withToken.some((a) => a.name === defaultAccount.name)
                ? defaultAccount.name
                : withToken[0].name;
        return plainSelect(withToken, defaultName);
    }

    const labelByName = new Map(withToken.map((a) => [a.name, a.label]));
    const picked = await p.select({
        message: "Launch Claude Code as which account? (best first)",
        initialValue: scored[0].accountName,
        options: scored.map((acc, i) => {
            const label = labelByName.get(acc.accountName);
            return {
                value: acc.accountName,
                label: `${TIER_BADGE[acc.tier]} ${acc.accountName}${label ? ` ${pc.dim(`(${label})`)}` : ""}${i === 0 ? pc.green(" ★") : ""}`,
                hint: scoredHint(acc),
            };
        }),
    });

    if (p.isCancel(picked)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return picked as string;
}

/**
 * Resolve [name] against token accounts: exact match first, then case-insensitive
 * substring. One match → use it; multiple + TTY → same picker as no-name launch
 * (scoped to the matches); zero → typed error.
 */
async function resolveAccountName(
    nameArg: string,
    withToken: AIAccountEntry[],
    opts: StartOptions,
    modelId: string | undefined,
    aiConfig: AIConfig
): Promise<string> {
    const needle = nameArg.toLowerCase();
    const exact = withToken.find((a) => a.name === nameArg || a.name.toLowerCase() === needle);

    if (exact) {
        return exact.name;
    }

    const matches = withToken.filter((a) => a.name.toLowerCase().includes(needle));

    if (matches.length === 1) {
        return matches[0].name;
    }

    if (matches.length > 1) {
        if (!isInteractive() && !opts.autopick) {
            out.error(pc.red(`Account "${nameArg}" is ambiguous in non-interactive mode.`));
            out.printlnErr(pc.dim(`Matches: ${matches.map((a) => a.name).join(", ")}`));
            out.printlnErr(suggestCommand("tools claude start", { add: ["--autopick", nameArg] }));
            await out.flush();
            process.exit(1);
        }

        return pickAccount(matches, opts, modelId, aiConfig);
    }

    const hasEntry = aiConfig.getAccount(nameArg);
    if (hasEntry && opts.keychain) {
        out.error(pc.red(`Account "${nameArg}" has no secondary login.`));
        out.printlnErr(pc.dim(`Save one with: ${pc.cyan(`tools claude login-secondary ${nameArg}`)}`));
    } else if (hasEntry) {
        out.error(pc.red(`Account "${nameArg}" has no long-lived token.`));
        out.printlnErr(pc.dim(`Save one with: ${pc.cyan(`tools claude login-long ${nameArg}`)}`));
    } else {
        out.error(pc.red(`Account "${nameArg}" not found.`));
        out.printlnErr(pc.dim(`With token: ${withToken.map((a) => a.name).join(", ")}`));
    }

    await out.flush();
    process.exit(1);
}

async function resolveResumeArgs(opts: StartOptions): Promise<string[]> {
    if (opts.continue) {
        if (opts.resume) {
            out.printlnErr(pc.dim("Both --continue and --resume given; using --continue."));
        }

        return ["--continue"];
    }

    if (opts.resume === true) {
        return ["--resume"];
    }

    if (typeof opts.resume === "string") {
        const session = await pickSessionForResume(opts.resume, { allProjects: false });
        if (!/^[\w-]+$/.test(session.sessionId)) {
            throw new Error(`Invalid session ID: ${session.sessionId}`);
        }

        return ["--resume", session.sessionId];
    }

    return [];
}

async function main(nameArg: string | undefined, opts: StartOptions, passthrough: string[]): Promise<never> {
    const aiConfig = await AIConfig.load();
    const withToken = aiConfig
        .getAccountsByProvider("anthropic-sub")
        .filter((a) => (opts.keychain ? Boolean(a.secondary) : Boolean(a.tokens.longLivedToken)));

    if (withToken.length === 0) {
        if (opts.keychain) {
            out.error(pc.red("No accounts with a secondary login."));
            out.printlnErr(pc.dim(`Run ${pc.cyan("tools claude login-secondary <name>")} first to save one.`));
        } else {
            out.error(pc.red("No accounts with a long-lived token."));
            out.printlnErr(
                pc.dim(`Run ${pc.cyan("tools claude login-long")} first to save one (see \`claude setup-token\`).`)
            );
        }
        await out.flush();
        process.exit(1);
    }

    const modelId = opts.model ? await resolveModel(opts.model) : undefined;

    let accountName: string;

    if (nameArg) {
        accountName = await resolveAccountName(nameArg, withToken, opts, modelId, aiConfig);
    } else {
        accountName = await pickAccount(withToken, opts, modelId, aiConfig);
    }

    const account = withToken.find((a) => a.name === accountName)!;

    const resumeArgs = await resolveResumeArgs(opts);

    let injectedUuid: string | undefined;
    let foreignBackupPath: string | undefined;

    if (opts.keychain) {
        const { preSync, foreign } = await inspectKeychainBeforeInject(aiConfig);

        if (preSync.status === "synced") {
            out.printlnErr(pc.dim(`Keychain held a rotated login — synced back to "${preSync.account}".`));
        }

        if (foreign) {
            const who = foreign.uuid ? `account uuid ${foreign.uuid}` : "an unknown account";
            if (!isInteractive()) {
                out.error(
                    pc.red(
                        `Keychain holds a Claude Code login for ${who} that no configured secondary login matches. ` +
                            "Refusing to overwrite it non-interactively."
                    )
                );
                await out.flush();
                process.exit(1);
            }

            const proceed = await p.confirm({
                message:
                    `The keychain holds a Claude Code login for ${who} (probably a direct /login). ` +
                    "Back it up and restore it after this session?",
                initialValue: false,
            });

            if (p.isCancel(proceed) || !proceed) {
                p.cancel("Cancelled — keychain untouched.");
                process.exit(0);
            }
        }

        // Re-read: the pre-inject sync may have refreshed this account's secondary tokens.
        const fresh = aiConfig.getAccount(accountName);
        const secondary = fresh?.secondary;

        if (!secondary) {
            out.error(pc.red(`Account "${accountName}" lost its secondary login — run login-secondary again.`));
            await out.flush();
            process.exit(1);
        }

        injectedUuid = secondary.accountUuid;
        foreignBackupPath = await injectSecondaryLogin(secondary, foreign !== null);
    } else {
        await ensureOnboardingSkippedForOAuthToken();
    }

    const cmd = await findClaudeCommand();
    const shell = env.paths.getShell("/bin/sh");

    const extraArgs: string[] = [];
    if (modelId) {
        extraArgs.push("--model", modelId);
    }

    extraArgs.push(...resumeArgs, ...passthrough);

    const suffix = extraArgs.length > 0 ? ` ${extraArgs.map(shellQuote).join(" ")}` : "";
    const detail = [
        account.label ? `(${account.label})` : "",
        modelId ? `model ${pc.magenta(modelId)}` : "",
        resumeArgs.length > 0 ? pc.dim(resumeArgs.join(" ")) : "",
    ]
        .filter(Boolean)
        .join(" ");

    const mode = opts.keychain ? "keychain login" : "long-lived token";
    out.printlnErr(pc.dim(`Starting Claude as ${pc.cyan(accountName)} (${mode})${detail ? ` ${detail}` : ""}...`));
    logger.debug({ cmd, accountName, modelId, resumeArgs, passthrough, mode }, "Spawning claude");

    let launchEnv: Record<string, string | undefined>;

    if (opts.keychain) {
        // Keychain auth: the env token must NOT be set (it takes precedence
        // over the keychain), and the full-scope login needs none of the
        // setup-token workarounds — the bootstrap catalog loads natively.
        // TOOLS_CLAUDE_ACCOUNT lets the statusline (a child of claude) show
        // which account this session was launched as.
        launchEnv = { ...process.env, TOOLS_CLAUDE_ACCOUNT: account.name };
        delete launchEnv.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
        launchEnv = {
            ...process.env,
            TOOLS_CLAUDE_ACCOUNT: account.name,
            CLAUDE_CODE_OAUTH_TOKEN: account.tokens.longLivedToken!,
            // Interactive CC can't resolve the tier from an inference-only setup token,
            // which blocks opus/sonnet [1m] model switches (see claude-code#70124).
            CLAUDE_CODE_SUBSCRIPTION_TYPE: account.label?.split(" ")[0] ?? "max",
            // The /model *catalog* comes from /api/claude_cli/bootstrap, which 403s for
            // inference-only setup tokens ("scope requirement user:profile") — so Fable
            // never loads. These two env vars are CC's escape hatches:
            //  1. ANTHROPIC_DEFAULT_FABLE_MODEL opens the Fable availability gate (vYe()),
            //     so `/model fable` and Fable inference are allowed. But it does NOT add
            //     Fable to the *picker list* for first-party OAuth (that path is gated by
            //     Xf()/firstParty and stays empty).
            //  2. ANTHROPIC_CUSTOM_MODEL_OPTION pushes an entry straight into the picker
            //     list, ungated by first-party — so "Fable 5" shows up in `/model` without
            //     the user having to type it. `[1m]` selects the 1M-context Fable.
            ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
            ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-fable-5[1m]",
            ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Fable 5",
            ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fable 5 · Most capable for hardest and longest-running tasks",
        };
    }

    const proc = Bun.spawn({
        cmd: [shell, "-ic", `exec ${cmd}${suffix}`],
        stdio: ["inherit", "inherit", "inherit"],
        env: launchEnv,
    });

    const exitCode = await proc.exited;

    if (opts.keychain) {
        try {
            const result = await finishKeychainSession(aiConfig, injectedUuid, foreignBackupPath);

            if (result.status === "synced") {
                out.printlnErr(pc.dim(`Synced rotated keychain tokens back to "${result.account}".`));
            } else if (result.status === "no-match") {
                out.printlnErr(
                    pc.yellow(
                        `Keychain now holds a different login (uuid ${result.uuid}) — left untouched, nothing synced.`
                    )
                );
            }
        } catch (err) {
            logger.error({ err }, "[keychain] post-session sync failed");
            out.printlnErr(pc.red(`Keychain sync-back failed: ${err instanceof Error ? err.message : err}`));
        }
    }

    process.exit(exitCode);
}

export function registerStartCommand(program: Command): void {
    const startCmd = program
        .command("start [name]")
        .description(
            "Launch Claude Code using a saved long-lived token (CLAUDE_CODE_OAUTH_TOKEN). " +
                "[name] matches account names by exact or substring (TTY prompts when ambiguous). " +
                "Args after -- are passed through to claude."
        )
        .allowExcessArguments(true)
        .option("--pick", "Pick the account from a usage-ranked list (best first, with reasoning)")
        .option("-a, --autopick", "Auto-pick the best account by usage headroom heuristic")
        .option("-m, --model <spec>", "Model to launch: alias or substring filter (fable, opus, 4.8 1m, ...)")
        .option("-r, --resume [query]", "Resume a session: bare uses claude's own picker, query searches locally")
        .option("-c, --continue", "Continue the most recent session")
        .option(
            "--keychain",
            "Run logged-in via the account's secondary login injected into the macOS keychain " +
                "(instead of CLAUDE_CODE_OAUTH_TOKEN); rotated tokens sync back to the account on exit"
        )
        .action(async (name: string | undefined, opts: StartOptions, command: Command) => {
            const operands = command.args;
            let nameArg = name;
            let passthrough = operands.slice(1);

            // `start -- --foo` binds "--foo" to [name]; treat leading-dash names as passthrough
            if (nameArg?.startsWith("-")) {
                nameArg = undefined;
                passthrough = operands;
            }

            try {
                await main(nameArg, opts, passthrough);
            } catch (error) {
                if (error instanceof Error && (error.name === "ExitPromptError" || error.message === "Cancelled")) {
                    process.exit(0);
                }
                throw error;
            }
        });

    startCmd.alias("run");
}
