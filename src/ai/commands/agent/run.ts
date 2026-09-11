import type { Command } from "commander";
import { launchAgent } from "./launch";
import type { AgentToolSpec } from "./spec";

/** Per-parse, not per-registration: the flag used to survive into the next parseAsync. */
function onceOption(seen: Set<string>, name: string): () => void {
    return () => {
        if (seen.has(name)) {
            throw new Error(`Specify --${name} only once`);
        }
        seen.add(name);
    };
}

export interface AgentRunFlags {
    resume?: string | boolean;
    continue?: boolean;
    model?: string;
    all?: boolean;
    allProjects?: boolean;
    cwd?: string;
    list?: boolean;
    limit?: string;
    [extra: string]: unknown;
}

/**
 * Number-or-nothing for `-n, --limit`. Rejecting "nope" here keeps commander's generic
 * "argument missing" out of the picture for a flag the user can see the values of.
 */
export function parseLimitFlag(raw: string | undefined, fallback = 20): number {
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }

    const trimmed = raw.trim();

    if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) < 1) {
        throw new Error(`--limit must be a positive integer (got "${raw}")`);
    }

    return Number.parseInt(trimmed, 10);
}

/**
 * `tools <agent> run [account] [args...]`, alias `start`: the interactive native TUI as an
 * account, fresh, on the native picker, or on a session resolved from a query.
 *
 * The account is OPTIONAL on every tool. `tools codex run` used to declare it as a required
 * positional, so `tools codex run --resume astra` bound `astra` to the optional-value
 * `--resume` and died on `missing required argument 'account'` while the same line on
 * `tools claude run` opened the picker. The flag set is declared once here; a tool adds its
 * own through `launcher.extendRun`.
 */
export function registerAgentRunCommand(program: Command, spec: AgentToolSpec): Command {
    const seen = new Set<string>();
    const run = program
        .command("run [account] [args...]")
        .alias("start")
        .description(`Open the ${spec.alias} terminal as an account (picker when omitted); args after -- pass through`)
        .option("-r, --resume [query]", "Resume a session: bare uses the native picker, a query searches the index")
        .option("-c, --continue", "Continue the most recent session in this directory")
        .option("-m, --model <model>", "Model id or alias")
        .option("--all", "With --resume, search every project, not only this directory")
        .option("--cwd <path>", "Working directory")
        .addOption(program.createOption("--all-projects", "alias of --all").hideHelp())
        .allowUnknownOption()
        .on("option:model", onceOption(seen, "model"))
        .on("option:resume", onceOption(seen, "resume"))
        .hook("preAction", () => {
            seen.clear();
        });

    spec.launcher.extendRun?.(run);

    run.action(async (account: string | undefined, args: string[], flags: AgentRunFlags) => {
        // `run -- --foo` binds "--foo" to [account]; a leading dash is native argv, never a name.
        const requested = account?.startsWith("-") ? undefined : account;
        const passthrough = account?.startsWith("-") ? [account, ...args] : args;

        await launchAgent(spec, {
            ...(requested === undefined ? {} : { account: requested }),
            ...(flags.resume === undefined ? {} : { resume: flags.resume }),
            continueLast: flags.continue === true,
            ...(flags.model === undefined ? {} : { model: flags.model }),
            all: flags.all === true || flags.allProjects === true,
            ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
            list: flags.list === true,
            limit: parseLimitFlag(flags.limit),
            passthrough,
            flags,
            subcommand: ["run"],
        });
    });

    return run;
}

/**
 * `tools <agent> resume [query]`: the same launch path with the query positional, for hands
 * that reach for `resume` before `run --resume`. `--account` names the account; the picker
 * runs otherwise, exactly as on `run`.
 */
export function registerAgentResumeCommand(program: Command, spec: AgentToolSpec): Command {
    const resume = program
        .command("resume [query]")
        .description(`Resume a ${spec.alias} session by id, title, or content search (bare: the native picker)`)
        .option("--account <name>", "Account to open it as (picker when omitted)")
        .option("-l, --list", "List the matching sessions instead of launching")
        .option("-a, --all", "Search every project, not only this directory")
        .option("-n, --limit <n>", "Number of sessions to list", "20")
        .option("-m, --model <model>", "Model id or alias")
        .option("--cwd <path>", "Working directory")
        .action(async (query: string | undefined, flags: AgentRunFlags & { account?: string }) => {
            await launchAgent(spec, {
                ...(flags.account === undefined ? {} : { account: flags.account }),
                resume: query ?? true,
                ...(flags.model === undefined ? {} : { model: flags.model }),
                all: flags.all === true,
                ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
                list: flags.list === true,
                limit: parseLimitFlag(flags.limit),
                passthrough: [],
                flags,
                subcommand: ["resume"],
            });
        });

    return resume;
}
