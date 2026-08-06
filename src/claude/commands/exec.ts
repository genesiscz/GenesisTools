import { ensureOnboardingSkippedForOAuthToken, pinnedLaunchEnv } from "@app/claude/lib/launch-env";
import { scoreAccounts, sortGrouped } from "@app/claude/lib/usage/account-picker";
import { peekSharedUsage } from "@app/claude/lib/usage/shared-cache";
import * as p from "@clack/prompts";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { LONG_TOKEN_MIN_LENGTH } from "@genesiscz/utils/claude/token-verify";
import { isInteractive } from "@genesiscz/utils/cli";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

export interface ExecArgs {
    /** Account named with -a/--account, if any. */
    name?: string;
    /** The command to run, argv-style. */
    command: string[];
}

/**
 * `exec [-a <name>] [--] <command> [args...]`. Parsed by hand rather than by
 * commander so the child's own flags (`tools shops crawl --dry-run`) are never
 * mistaken for ours: only a LEADING -a/--account belongs to us.
 */
export function parseExecArgs(args: string[]): ExecArgs {
    let name: string | undefined;
    let rest = args;

    if (rest[0] === "-a" || rest[0] === "--account") {
        name = rest[1];
        rest = rest.slice(2);
    } else if (rest[0]?.startsWith("--account=")) {
        name = rest[0].slice("--account=".length);
        rest = rest.slice(1);
    }

    if (rest[0] === "--") {
        rest = rest.slice(1);
    }

    return { name, command: rest };
}

/**
 * Unattended pick (a hook, CI, a git hook): rank by the same usage heuristic the
 * interactive picker uses and skip anything that cannot serve a turn. Falls back
 * to the first configured account when no usage data exists at all.
 */
async function autoPick(eligible: AIAccountEntry[]): Promise<AIAccountEntry> {
    const cached = await peekSharedUsage().catch((error) => {
        logger.debug({ error }, "[exec] usage cache unavailable; falling back to the first account");
        return null;
    });

    if (!cached) {
        return eligible[0];
    }

    const names = new Set(eligible.map((a) => a.name));
    const ranked = sortGrouped(scoreAccounts(cached.accounts.filter((a) => names.has(a.accountName)))).filter(
        (s) => !s.subscriptionExpired && s.group !== "dead" && s.group !== "expired" && s.tier !== "weekly-blocked"
    );

    const best = ranked[0] && eligible.find((a) => a.name === ranked[0].accountName);

    return best ?? eligible[0];
}

async function resolveAccount(eligible: AIAccountEntry[], name: string | undefined): Promise<AIAccountEntry> {
    if (name) {
        const match = eligible.find((a) => a.name === name);

        if (!match) {
            out.error(pc.red(`Account "${name}" has no long-lived token.`));
            out.printlnErr(pc.dim(`With a token: ${eligible.map((a) => a.name).join(", ")}`));
            await out.flush();
            process.exit(1);
        }

        return match;
    }

    if (!isInteractive()) {
        return autoPick(eligible);
    }

    const picked = await p.select({
        message: "Run as which account?",
        options: eligible.map((a) => ({ value: a.name, label: a.name, hint: a.label })),
    });

    if (p.isCancel(picked)) {
        p.cancel("Cancelled — nothing ran.");
        process.exit(0);
    }

    return eligible.find((a) => a.name === picked)!;
}

export async function execCommand(args: string[]): Promise<never> {
    const { name, command } = parseExecArgs(args);

    if (command.length === 0) {
        out.error(pc.red("Nothing to run."));
        out.printlnErr(pc.dim("Usage: tools claude exec [-a <account>] [--] <command> [args...]"));
        await out.flush();
        process.exit(1);
    }

    const config = await AIConfig.load();
    const eligible = config.getAccountsByProvider("anthropic-sub").filter((a) => a.tokens.longLivedToken);

    if (eligible.length === 0) {
        out.error(pc.red("No accounts with a long-lived token."));
        out.printlnErr(pc.dim(`Run ${pc.cyan("tools claude login-long")} first to save one.`));
        await out.flush();
        process.exit(1);
    }

    const account = await resolveAccount(eligible, name);
    const token = account.tokens.longLivedToken!;

    // A truncated token 401s and Claude Code SILENTLY falls back to the keychain
    // login — the exact wrong-account failure this command exists to prevent.
    if (token.length < LONG_TOKEN_MIN_LENGTH) {
        out.error(pc.red(`The stored token for "${account.name}" is truncated (${token.length} chars, expect ~108).`));
        out.printlnErr(pc.dim(`Recapture it with: ${pc.cyan(`tools claude login-long ${account.name}`)}`));
        await out.flush();
        process.exit(1);
    }

    await ensureOnboardingSkippedForOAuthToken();

    // Only narrate to a terminal: a captured stderr (a release tool collecting
    // notes, a git hook) must not get this banner spliced into its output.
    if (process.stderr.isTTY) {
        out.printlnErr(pc.dim(`${pc.cyan("▸")} ${command.join(" ")} (as ${pc.cyan(account.name)}, token pinned)`));
    }

    logger.debug({ account: account.name, command }, "[exec] spawning with a pinned token");

    try {
        const proc = Bun.spawn({
            cmd: command,
            stdio: ["inherit", "inherit", "inherit"],
            env: { ...process.env, ...pinnedLaunchEnv(account, token) },
        });

        process.exit(await proc.exited);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            out.error(pc.red(`Command not found: ${command[0]}`));
            await out.flush();
            process.exit(127);
        }

        throw error;
    }
}

export function registerExecCommand(program: Command): void {
    program
        .command("exec")
        .description(
            "Run any command with an account's long-lived token in its environment " +
                "(so `claude -p` in hooks and CI never depends on the keychain login). " +
                "Usage: tools claude exec [-a <account>] [--] <command> [args...]"
        )
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action(async (_opts, command: Command) => {
            await execCommand(command.args);
        });
}
