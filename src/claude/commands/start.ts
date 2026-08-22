import { accountOwningKeychain } from "@app/claude/lib/doctor";
import { findRecentSessions, type SessionSummary } from "@app/claude/lib/history/limit-kill";
import {
    ensureOnboardingSkippedForOAuthToken,
    FABLE_MODEL_ID,
    FABLE_MODEL_OPTION,
    FABLE_MODEL_OPTION_DESCRIPTION,
    FABLE_MODEL_OPTION_NAME,
    pinnedLaunchEnv,
    subscriptionTypeOf,
} from "@app/claude/lib/launch-env";
import { type LaunchableModel, modelFamilyOf, resolveModelSpec } from "@app/claude/lib/models";
import { fmtHours, type ScoredAccount, scoreAccounts, sortGrouped } from "@app/claude/lib/usage/account-picker";
import { loadDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import {
    deadBucketForAccount,
    fableCapableAccounts,
    fableStatusForAccount,
    weeklyStatusForAccount,
} from "@app/claude/lib/usage/fable-guard";
import { getSharedAccountsUsage, peekSharedUsage } from "@app/claude/lib/usage/shared-cache";
import { pickSmart, type SmartAlias, smartAliasOf } from "@app/claude/lib/usage/smart-alias";
import { tableSelectAccount } from "@app/claude/lib/usage/table-select";
import { TIER_BADGE } from "@app/claude/lib/usage/usage-table";
import * as p from "@clack/prompts";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { findClaudeCommand } from "@genesiscz/utils/claude";
import { keychainOwnerUuidOffline } from "@genesiscz/utils/claude/keychain";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { finishKeychainSession, injectSecondaryLogin, inspectKeychainBeforeInject } from "../lib/keychain-session";
import { shellSingleQuote } from "../lib/shell-quote";
import {
    installTeammateWrapper,
    removeTeammateWrapper,
    resolveClaudeBinaryForTeammates,
    sweepStaleTeammateWrappers,
} from "../lib/teammate-wrapper";
import { pickSessionForResume } from "./resume";
import { runProxySession } from "./run";

interface StartOptions {
    pick?: boolean;
    autopick?: boolean;
    model?: string;
    resume?: string | boolean;
    continue?: boolean;
    keychain?: boolean;
    cmux?: boolean;
}

/** Same bound findClaudeCommand uses — an rc file that blocks must not hang the launch. */
const CMUX_PROBE_TIMEOUT_MS = 3000;

/**
 * `cmux claude-teams` launches claude with agent teams enabled and a tmux shim on PATH
 * (so Claude's tmux calls become cmux splits), forwarding every remaining arg to claude.
 * Resolved through the same interactive shell as findClaudeCommand so a PATH set up in
 * the user's rc (e.g. ~/.local/bin) is visible.
 */
async function findCmuxTeamsCommand(shell: string): Promise<string> {
    const proc = Bun.spawn({
        cmd: [shell, "-ic", "command -v cmux"],
        stdio: ["ignore", "pipe", "ignore"],
    });

    let path: string | undefined;

    try {
        const stdout = await Promise.race([
            new Response(proc.stdout).text(),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), CMUX_PROBE_TIMEOUT_MS)),
        ]);
        await proc.exited;

        // A failed `command -v` still prints whatever the rc init wrote to stdout,
        // and that text would be exec'd as the command. Only a clean exit with a
        // single bare token (absolute path, or a function/builtin name) counts.
        const candidate = stdout.trim().split("\n").pop()?.trim();
        if (proc.exitCode === 0 && candidate && !/\s/.test(candidate)) {
            path = candidate;
        }
    } catch (error) {
        logger.debug({ error, shell }, "[start] cmux probe timed out or failed");
    } finally {
        proc.kill();
    }

    if (!path) {
        out.error(pc.red("--cmux needs the `cmux` CLI on PATH, but it was not found."));
        out.printlnErr(pc.dim("Install cmux (or drop --cmux to launch claude directly)."));
        await out.flush();
        process.exit(1);
    }

    logger.debug({ path, shell }, "[start] resolved cmux for claude-teams launch");
    return `${shellSingleQuote(path)} claude-teams`;
}

/**
 * `cmux claude-teams` execs the bare `claude` binary, bypassing the user's shell wrapper
 * (`ccc`, findClaudeCommand's first candidate) whose whole job is adding
 * `--dangerously-skip-permissions`. Re-add it so --cmux sessions behave like the default
 * launch instead of silently regressing to permission prompts. An explicit
 * `--permission-mode` (or the flag itself) always wins.
 */
export function cmuxPermissionArgs(forwarded: string[]): string[] {
    const alreadySet = forwarded.some(
        (arg) => arg === "--dangerously-skip-permissions" || arg.startsWith("--permission-mode")
    );

    if (alreadySet) {
        logger.debug({ forwarded }, "[start] --cmux: caller set permission flags, not injecting");
        return [];
    }

    return ["--dangerously-skip-permissions"];
}

/**
 * Argv appended after the resolved claude command. Forwarded args go LAST because
 * they may contain a `--` separator or a positional prompt, past which claude stops
 * reading options — anything we inject after that would be swallowed as prompt text.
 */
export function buildLaunchArgs(input: {
    modelId?: string;
    resumeArgs: string[];
    passthrough: string[];
    cmux: boolean;
}): string[] {
    const args: string[] = [];

    if (input.modelId) {
        args.push("--model", input.modelId);
    }

    const forwarded = [...input.resumeArgs, ...input.passthrough];

    if (input.cmux) {
        args.push(...cmuxPermissionArgs(forwarded));
    }

    args.push(...forwarded);

    return args;
}

/** Headless launch (`-p`/`--print`): claude prints a result and exits, no TUI. */
function isHeadlessPassthrough(passthrough: string[]): boolean {
    return passthrough.some((arg) => arg === "-p" || arg === "--print");
}

/**
 * The interactive shell (`-ic`) we spawn to pick up the user's ccc/claude wrappers
 * emits `(eval):N: can't change option: zle` during rc init when a plugin toggles
 * the ZLE option without a usable line editor. It's cosmetic. In headless mode the
 * shell's stderr carries only diagnostics (no TUI), so drop just those benign lines
 * and forward everything else through.
 */
async function forwardStderrDroppingZleNoise(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const isZleNoise = (line: string) => /can't change option: zle/.test(line);
    const reader = stream.getReader();
    let buffer = "";

    const flushLine = (line: string) => {
        if (!isZleNoise(line)) {
            process.stderr.write(line);
        }
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
                flushLine(buffer.slice(0, newlineIndex + 1));
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf("\n");
            }
        }

        buffer += decoder.decode();
        if (buffer) {
            flushLine(buffer);
        }
    } finally {
        reader.releaseLock();
    }
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

/**
 * Instant picker: the warm cache paints the table immediately and the live
 * fetch only runs when the cache is missing or the caller forces it. The
 * daemon refreshes every minute anyway, so waiting on the network before
 * drawing anything was pure latency.
 */
async function scoreTokenAccounts(
    withToken: AIAccountEntry[],
    modelId: string | undefined
): Promise<ScoredAccount[] | null> {
    const names = withToken.map((a) => a.name);
    const wanted = new Set(names);
    const scoreOpts = { modelFamily: modelId ? modelFamilyOf(modelId) : undefined };

    const cached = await peekSharedUsage().catch((error) => {
        logger.debug({ error }, "usage cache peek failed; falling back to a live fetch");
        return null;
    });
    const cachedAccounts = cached?.accounts.filter((a) => wanted.has(a.accountName)) ?? [];
    // A PARTIAL cache (e.g. an account added since the last poll) must not
    // silently drop the missing accounts from the picker — fall through to the
    // live fetch so every requested account is offered.
    const cacheCoversAll = cachedAccounts.length === names.length;

    if (cacheCoversAll && cachedAccounts.length > 0) {
        const age = Math.round((Date.now() - cached!.fetchedAt) / 1000);
        logger.debug({ age, accounts: cachedAccounts.length }, "picker painting from the warm usage cache");

        // Revalidate in the background: the next launch gets fresher numbers
        // without this one paying for it. Failures are the daemon's problem.
        void getSharedAccountsUsage({ accountFilter: names }).catch((error) => {
            logger.debug({ error }, "background usage revalidation failed");
        });

        // Grouped urgency (fable → opus → dead → expired) so the launch picker
        // agrees with the usage TUI; dead/expired stay visible at the bottom.
        return sortGrouped(scoreAccounts(cachedAccounts, scoreOpts));
    }

    const spinner = p.spinner();
    spinner.start("Checking usage across accounts...");

    try {
        const usage = await getSharedAccountsUsage({ accountFilter: names });
        if (usage.length === 0) {
            spinner.stop(pc.yellow("No usage data available"));
            return null;
        }

        const scored = sortGrouped(scoreAccounts(usage, scoreOpts));
        spinner.stop(`Ranked ${scored.length} account${scored.length === 1 ? "" : "s"} by usage headroom`);
        return scored;
    } catch (error) {
        spinner.stop(pc.yellow("Usage check failed"));
        logger.warn({ error }, "Account scoring failed, falling back to plain selection");
        return null;
    }
}

/**
 * Warn before launching an account whose Fable weekly bucket is spent, and offer
 * the Opus fallback. Deliberately narrow:
 *  - only when the launch would actually use Fable (no `--model`, or `--model fable`);
 *  - never during `--resume`/`--continue`, where interrupting to renegotiate the
 *    model would derail resuming the session the user asked for;
 *  - an EXPLICIT `--model` is honored — the warning is informational, never a veto.
 * Reads the warm cache only; a cache miss means UNKNOWN, which never blocks.
 */
async function guardFableHeadroom(accountName: string, modelId: string | undefined, resuming: boolean): Promise<void> {
    if (resuming || !isInteractive()) {
        return;
    }

    const explicitFamily = modelId ? modelFamilyOf(modelId) : undefined;

    if (explicitFamily && explicitFamily !== "fable") {
        return;
    }

    const cached = await peekSharedUsage().catch((error) => {
        logger.debug({ error }, "fable guard: cache peek failed, skipping the check");
        return null;
    });

    if (!cached) {
        return;
    }

    const status = fableStatusForAccount(cached.accounts, accountName);

    if (status.available) {
        return;
    }

    const left = status.leftPct <= 0 ? "spent" : `${status.leftPct.toFixed(1)}% left`;
    const alternatives = fableCapableAccounts(cached.accounts).filter((name) => name !== accountName);

    // An explicit --model fable is the user's decision; say the number and move on.
    if (explicitFamily === "fable") {
        out.printlnErr(pc.yellow(`⚠ Fable weekly on "${accountName}" is ${left} — launching anyway (--model fable).`));

        if (alternatives.length > 0) {
            out.printlnErr(pc.dim(`  Accounts with Fable headroom: ${alternatives.join(", ")}`));
        }

        return;
    }

    out.printlnErr(pc.yellow(`⚠ Fable weekly on "${accountName}" is ${left}.`));

    if (alternatives.length > 0) {
        out.printlnErr(pc.dim(`  Accounts with Fable headroom: ${alternatives.join(", ")}`));
    }

    const proceed = await p.confirm({
        message: "Launch anyway? (No cancels so you can pick another account or model)",
        initialValue: true,
    });

    if (p.isCancel(proceed) || !proceed) {
        p.cancel("Cancelled — nothing launched.");
        process.exit(0);
    }
}

/**
 * An interactive session gates its turns on the KEYCHAIN account's limits, not
 * the pinned token's: a long-lived token is inference-only (the profile
 * endpoint 403s on it), so the UI reads usage from the keychain login and
 * refuses before sending. Inference still bills the pinned account. So a
 * limit-dead keychain kills every session on the machine. Say so.
 */
async function warnKeychainLimits(accountName: string, aiConfig: AIConfig, modelId: string | undefined): Promise<void> {
    const uuid = await keychainOwnerUuidOffline();

    if (!uuid) {
        return; // unmanaged or unknown login — nothing we can vouch for
    }

    const owner = accountOwningKeychain(aiConfig.getAccountsByProvider("anthropic-sub"), uuid);

    if (!owner || owner === accountName) {
        return;
    }

    const cached = await peekSharedUsage().catch(() => null);

    if (!cached) {
        return;
    }

    // An explicit non-Fable model does not care about the Fable bucket; every
    // launch cares about the all-model weekly one.
    const fableMatters = !modelId || modelFamilyOf(modelId) === "fable";
    const dead = deadBucketForAccount(cached.accounts, owner, fableMatters);

    if (!dead) {
        return;
    }

    out.printlnErr(
        pc.yellow(`⚠ The keychain is on "${owner}", which has no ${dead.bucket} left (${resetPhrase(dead.resetsAt)}).`)
    );
    out.printlnErr(
        pc.dim(
            "  Interactive sessions read their limits from the KEYCHAIN account even when pinned to another one,\n" +
                "  so this session would refuse on its first turn."
        )
    );
    out.printlnErr(pc.dim(`  Fix it with: ${pc.cyan(`tools claude start --keychain ${accountName}`)}`));
}

/** "resets in 2h 5m" / "resetting now" from an ISO reset timestamp. */
function resetPhrase(resetsAt: string | null): string {
    if (!resetsAt) {
        return "reset window unknown";
    }

    const hours = (new Date(resetsAt).getTime() - Date.now()) / 3_600_000;

    if (!Number.isFinite(hours) || hours <= 0) {
        return "resetting now";
    }

    return `resets in ${fmtHours(hours)}`;
}

/**
 * A weekly-dead account cannot serve ANY model: every turn 429s and Claude
 * Code silently falls back to the keychain account. This runs before the
 * interactive and --model checks on purpose. Both are escapes from a Fable
 * question, and neither is an escape from an empty weekly bucket.
 */
async function refuseIfWeeklyDead(accountName: string): Promise<void> {
    const cached = await peekSharedUsage().catch((error) => {
        logger.debug({ error }, "weekly gate: cache peek failed, skipping the check");
        return null;
    });

    if (!cached) {
        return;
    }

    const weekly = weeklyStatusForAccount(cached.accounts, accountName);

    if (weekly.available) {
        return;
    }

    out.error(pc.red(`⚠ "${accountName}" has no weekly quota left (${resetPhrase(weekly.resetsAt)}).`));
    out.printlnErr(pc.dim("  Every model 429s until it refills, so switching model would not help."));

    const withRoom = fableCapableAccounts(cached.accounts).filter((name) => name !== accountName);

    out.printlnErr(
        withRoom.length > 0
            ? pc.dim(`  Accounts with headroom: ${withRoom.join(", ")}`)
            : pc.dim("  No other account has weekly headroom right now.")
    );

    await out.flush();
    process.exit(1);
}

function scoredHint(account: ScoredAccount): string {
    return account.dataNote ? `${account.why} ${pc.yellow(`[${account.dataNote}]`)}` : account.why;
}

/**
 * `cc opus` / `cc fable` let the usage data choose the account (rules in
 * lib/usage/smart-alias.ts) and print what was picked plus the headroom it was
 * picked on. Returns null when nothing qualifies, so the caller falls back to
 * the picker: an alias never blocks a launch.
 */
async function resolveSmartAlias(
    alias: SmartAlias,
    withToken: AIAccountEntry[],
    modelId: string | undefined
): Promise<string | null> {
    const scored = await scoreTokenAccounts(withToken, modelId);

    if (!scored) {
        out.printlnErr(pc.yellow("Usage data unavailable — picking manually:"));
        return null;
    }

    const pick = pickSmart(alias, scored);

    if (!pick) {
        out.printlnErr(
            pc.yellow(
                alias === "fable"
                    ? "No account has Fable headroom right now — picking manually:"
                    : "No account has usable weekly headroom right now — picking manually:"
            )
        );
        return null;
    }

    if (pick.warning) {
        out.printlnErr(pc.yellow(`⚠ ${pick.warning}`));
    }

    out.printlnErr(`${pc.cyan("▸")} ${pc.bold(alias)} → ${pick.line}`);

    return pick.accountName;
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

        // An auto-pick must never land on an account that cannot serve a turn.
        // The interactive table still SHOWS these rows; only the automatic
        // choice skips them.
        const eligible = scored.filter(
            (s) => !s.subscriptionExpired && s.group !== "dead" && s.group !== "expired" && s.tier !== "weekly-blocked"
        );
        const best = eligible[0] ?? scored[0];

        if (eligible.length === 0) {
            out.printlnErr(pc.yellow("No account has usable headroom; picking the best of a bad set."));
        }

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

    const dashboardConfig = await loadDashboardConfig().catch((error) => {
        logger.debug({ error }, "Could not load dashboard config for pace scope; using the default");
        return null;
    });

    const picked = await tableSelectAccount({
        message: "Launch Claude Code as which account?",
        scored,
        accountsByName: new Map(withToken.map((a) => [a.name, a])),
        paceScope: dashboardConfig?.paceScope,
    });

    if (picked === null) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return picked;
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

/** "12m ago" / "2h ago" / "3d ago" — coarse on purpose, it's a disambiguator. */
function agePhrase(mtimeMs: number): string {
    const minutes = Math.max(0, Math.round((Date.now() - mtimeMs) / 60_000));

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * One row: `d8deebf0 · 12m ago · ⚠ limit · in .worktrees/fix · "the prompt"`.
 * The prompt goes in the LABEL rather than clack's `hint` (a hint only renders
 * on the focused row, and every row has to be identifiable) and is trimmed to
 * whatever the terminal has left, so no row wraps.
 */
function sessionLabel(session: SessionSummary): string {
    const short = session.id.slice(0, 8);
    const cells = [
        { plain: short, colored: pc.cyan(short) },
        { plain: agePhrase(session.mtimeMs), colored: agePhrase(session.mtimeMs) },
    ];

    if (session.limitStop) {
        cells.push({ plain: "⚠ limit", colored: pc.yellow("⚠ limit") });
    }

    if (session.subdir) {
        cells.push({ plain: `in ${session.subdir}`, colored: pc.dim(`in ${session.subdir}`) });
    }

    // 3 per separator; the 20 covers the "│  ● " gutter, the quotes, and
    // clack's own wrap margin — it wraps at `columns - prefix.length` on a
    // COLORED prefix, so its escape codes eat ~13 columns of the budget. A row
    // that overshoots wraps onto a second line and the picker turns to mush.
    const used = cells.reduce((n, cell) => n + cell.plain.length + 3, 20);
    const room = (process.stdout.columns ?? 80) - used;

    if (session.lastPrompt && room >= 20) {
        const text =
            session.lastPrompt.length > room ? `${session.lastPrompt.slice(0, room - 1)}…` : session.lastPrompt;
        cells.push({ plain: text, colored: pc.dim(`"${text}"`) });
    }

    return cells.map((cell) => cell.colored).join(pc.dim(" · "));
}

/** True when the user already told claude what to open (`--resume`, `-c`, `-p`, …). */
export function passthroughHandlesSession(passthrough: string[]): boolean {
    return passthrough.some((arg) =>
        [
            "--resume",
            "-r",
            "--continue",
            "-c",
            "--fork-session",
            "--print",
            "-p",
            // Teammate re-attach. Without this, `tools claude teams` attach
            // with `--agent-id` and no `--resume` pops the unrelated
            // limit-killed session picker ("Cancelled, nothing launched").
            "--agent-id",
        ].includes(arg.split("=")[0])
    );
}

/**
 * A session that died on a rate limit is the one case where a NEW session is
 * almost never what was wanted: relaunching under another account is exactly
 * how you carry on. The prompt is gated on the NEWEST session having died that
 * way; the other recent ones ride along so an older thread stays reachable.
 */
async function offerLimitKilledResume(): Promise<string[]> {
    if (!isInteractive()) {
        return [];
    }

    const cwd = process.cwd();
    const sessions = await findRecentSessions(cwd).catch((error) => {
        logger.debug({ error }, "[start] limit-killed session scan failed");
        return [];
    });

    if (!sessions[0]?.limitStop) {
        return [];
    }

    out.printlnErr(
        pc.yellow(`⚠ The last session here stopped on a limit ${pc.dim(`(${agePhrase(sessions[0].mtimeMs)})`)}`)
    );
    out.printlnErr(pc.dim(`  ${sessions[0].limitStop.slice(0, 160)}`));

    const picked = await p.select({
        message: `Resume a session in ${cwd.replace(env.paths.getHome() ?? "", "~")}?`,
        options: [
            ...sessions.map((session) => ({ value: session.id, label: sessionLabel(session) })),
            { value: "", label: "Start fresh" },
        ],
    });

    if (p.isCancel(picked)) {
        p.cancel("Cancelled — nothing launched.");
        process.exit(0);
    }

    return picked ? ["--resume", picked] : [];
}

async function resolveResumeArgs(opts: StartOptions, passthrough: string[]): Promise<string[]> {
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

    // The user said nothing about sessions. Offer the limit-killed one, if the
    // passthrough has not already told claude what to open.
    if (!passthroughHandlesSession(passthrough)) {
        return offerLimitKilledResume();
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

    const explicitModelId = opts.model ? await resolveModel(opts.model) : undefined;
    const alias = smartAliasOf(
        nameArg,
        withToken.map((a) => a.name)
    );

    // `cc opus` / `cc fable` name a model as well as a strategy. An explicit
    // --model always wins.
    const modelId =
        explicitModelId ??
        (alias === "opus" ? "claude-opus-5[1m]" : alias === "fable" ? "claude-fable-5[1m]" : undefined);

    let accountName: string;

    if (alias) {
        accountName =
            (await resolveSmartAlias(alias, withToken, modelId)) ??
            (await pickAccount(withToken, opts, modelId, aiConfig));
    } else if (nameArg) {
        accountName = await resolveAccountName(nameArg, withToken, opts, modelId, aiConfig);
    } else {
        accountName = await pickAccount(withToken, opts, modelId, aiConfig);
    }

    const account = withToken.find((a) => a.name === accountName)!;

    await refuseIfWeeklyDead(accountName);

    if (!opts.keychain) {
        await warnKeychainLimits(accountName, aiConfig, modelId);
    }

    const resumeArgs = await resolveResumeArgs(opts, passthrough);

    await guardFableHeadroom(accountName, modelId, resumeArgs.length > 0);

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

    const shell = env.paths.getShell("/bin/sh");
    const cmd = opts.cmux ? await findCmuxTeamsCommand(shell) : await findClaudeCommand();

    const extraArgs = buildLaunchArgs({ modelId, resumeArgs, passthrough, cmux: opts.cmux === true });

    const suffix = extraArgs.length > 0 ? ` ${extraArgs.map(shellSingleQuote).join(" ")}` : "";
    const detail = [
        account.label ? `(${account.label})` : "",
        modelId ? `model ${pc.magenta(modelId)}` : "",
        opts.cmux ? pc.cyan("via cmux claude-teams") : "",
        resumeArgs.length > 0 ? pc.dim(resumeArgs.join(" ")) : "",
    ]
        .filter(Boolean)
        .join(" ");

    const mode = opts.keychain ? "keychain login" : "long-lived token";
    const headless = isHeadlessPassthrough(passthrough);
    if (!headless) {
        out.printlnErr(pc.dim(`Starting Claude as ${pc.cyan(accountName)} (${mode})${detail ? ` ${detail}` : ""}...`));
    }

    logger.debug({ cmd, accountName, modelId, resumeArgs, passthrough, extraArgs, mode, headless }, "Spawning claude");

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
        launchEnv = { ...process.env, ...pinnedLaunchEnv(account, account.tokens.longLivedToken!) };
    }

    // Agent-team tmux teammates do NOT inherit CLAUDE_CODE_OAUTH_TOKEN (CC spawn
    // allowlist). Point CLAUDE_CODE_TEAMMATE_COMMAND at a per-PID wrapper that
    // re-exports this launch env. See Claude/Bugs/TeammateTmuxNotRespectingOauthTokens.
    let teammateWrapperPath: string | undefined;
    if (!opts.keychain && account.tokens.longLivedToken) {
        try {
            sweepStaleTeammateWrappers();
            const installed = installTeammateWrapper({
                claudeBin: resolveClaudeBinaryForTeammates(),
                env: {
                    accountName: account.name,
                    oauthToken: account.tokens.longLivedToken,
                    subscriptionType: subscriptionTypeOf(account),
                    fableModel: FABLE_MODEL_ID,
                    customModelOption: FABLE_MODEL_OPTION,
                    customModelOptionName: FABLE_MODEL_OPTION_NAME,
                    customModelOptionDescription: FABLE_MODEL_OPTION_DESCRIPTION,
                },
            });
            teammateWrapperPath = installed.path;
            launchEnv.CLAUDE_CODE_TEAMMATE_COMMAND = installed.path;
        } catch (error) {
            logger.warn({ error }, "[start] teammate OAuth wrapper install failed — tmux mates may not auth");
        }
    }

    let exitCode: number;

    try {
        const proc = Bun.spawn({
            cmd: [shell, "-ic", `exec ${cmd}${suffix}`],
            stdio: ["inherit", "inherit", headless ? "pipe" : "inherit"],
            env: launchEnv,
        });

        const stderrPump = headless && proc.stderr ? forwardStderrDroppingZleNoise(proc.stderr) : null;

        exitCode = await proc.exited;
        if (stderrPump) {
            await stderrPump;
        }

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
    } finally {
        // The wrapper holds the OAuth token in plaintext — it must be unlinked
        // before we leave, and process.exit() inside the try would skip this.
        removeTeammateWrapper(teammateWrapperPath);
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
        .option(
            "--cmux",
            "Launch through `cmux claude-teams` instead of claude directly (agent teams + tmux shim so " +
                "Claude's tmux calls become cmux splits); all other args forward unchanged. Adds " +
                "--dangerously-skip-permissions to match the shell wrapper cmux bypasses, unless you pass " +
                "your own permission flag"
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

            // No Anthropic account name contains a slash, but every ai-proxy target
            // does (`martin/grok`, `work/xai/grok-4.6`). That makes the split
            // unambiguous, so `claude run martin/grok -m 4.6` reaches the proxy
            // launcher without a second command name to remember.
            if (nameArg?.includes("/")) {
                await runProxySession(nameArg, { model: opts.model }, passthrough);
                return;
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
