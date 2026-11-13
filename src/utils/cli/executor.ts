import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { profiler } from "@genesiscz/utils/profile";
import { redactSecretsInText } from "@genesiscz/utils/transclude/redact";
import { type Command, Help, type Option } from "commander";
import pc from "picocolors";
import type { DeadlineExpiry } from "./failures/record";

export { isInteractive } from "./is-interactive";

/**
 * Enhance a Commander program with better help UX:
 * - Shows help after errors (e.g. too many arguments)
 * - Expands subcommand options in the parent's help output
 * - Recurses into nested subcommands
 *
 * Call once on the root program after all commands are registered.
 */
const HELP_FLAG_WIDTH = 30;
const HELP_INDENT = 4;
const HELP_MIN_TEXT_WIDTH = 30;

/** Terminal width, with the usual fallback for a pipe or a dumb terminal. */
function helpWidth(): number {
    const columns = process.stdout.columns;

    return Number.isFinite(columns) && (columns ?? 0) > 0 ? (columns as number) : 80;
}

/**
 * The description Commander itself would print, including the trailing `(default: …)`.
 *
 * Commander appends defaults at RENDER time from `option.defaultValue`; they are not part of
 * `option.description`. Reading only the description therefore produced two help renderers
 * that disagreed: `play plan new --help` said `--from <source> … (default: "top")` while the
 * same option one level up in `play plan --help` showed no default at all. A usability tester
 * could not tell whether `--from` was required, and had to make an extra help call to find
 * out — for the one flag that decides which music gets sampled.
 */
function describeOption(option: {
    description: string;
    defaultValue?: unknown;
    defaultValueDescription?: string;
    mandatory?: boolean;
}) {
    const required = option.mandatory === true ? " (required)" : "";

    if (option.defaultValue === undefined) {
        return `${option.description}${required}`;
    }

    const shown = option.defaultValueDescription ?? SafeJSON.stringify(option.defaultValue);

    return `${option.description}${required} (default: ${shown})`;
}

/**
 * Wrap a description under a hanging indent aligned with the flag column.
 *
 * Commander wraps its OWN option lists; this block bypassed it and printed each description
 * on one line, so `play plan --help` emitted a 263-character line for `--from` (it names all
 * five seed sources inline). At any normal width that is unreadable, and it is the help for
 * the flag a new user most needs.
 */
function wrapDescription(description: string, available: number): string[] {
    const words = description.split(/\s+/).filter(Boolean);
    if (!words.length) {
        return [""];
    }

    const lines: string[] = [];
    let current = "";
    for (const word of words) {
        // A single word longer than the column is emitted whole rather than broken: these are
        // paths, URLs and flag names, and hyphenating them makes them uncopyable.
        if (current && `${current} ${word}`.length > available) {
            lines.push(current);
            current = word;
        } else {
            current = current ? `${current} ${word}` : word;
        }
    }
    lines.push(current);

    return lines;
}

/**
 * Turn on `showHelpAfterError` for a command AND every subcommand under it.
 *
 * Commander does not inherit this setting: setting it on the root program only covers errors the
 * root itself raises. A missing argument on a subcommand is raised by that subcommand, so without
 * this the user gets a bare `error: missing required argument 'entry'` and no usage at all — which
 * is exactly the moment help is worth most.
 */
/**
 * Print `(required)` next to a required option, for a command AND every subcommand under it.
 *
 * Commander renders a required option exactly like an optional one, and reports only the FIRST
 * missing one per run. So a caller pays one failed invocation PER required flag just to learn the
 * call shape: `control sequence` raised `--role`, then `--within`, then ran. Marking them makes the
 * help printed beside that first error enough to fix the whole command line at once.
 */
export function markRequiredOptionsDeep(cmd: Command): void {
    // configureHelp(config) replaces the whole configuration; keep what the tool set (e.g. commandUsage).
    cmd.configureHelp({
        ...cmd.configureHelp(),
        optionDescription(this: Help, option: Option): string {
            const base = Help.prototype.optionDescription.call(this, option);

            return option.mandatory ? `${base} (required)` : base;
        },
    });

    for (const sub of cmd.commands as Command[]) {
        markRequiredOptionsDeep(sub);
    }
}

export function showHelpAfterErrorDeep(cmd: Command): void {
    cmd.showHelpAfterError(true);

    for (const sub of cmd.commands as Command[]) {
        showHelpAfterErrorDeep(sub);
    }
}

export function enhanceHelp(cmd: Command): void {
    cmd.showHelpAfterError(true);

    const subs = cmd.commands as Command[];
    if (subs.length > 0) {
        cmd.addHelpText("after", () => {
            const available = Math.max(HELP_MIN_TEXT_WIDTH, helpWidth() - HELP_INDENT - HELP_FLAG_WIDTH - 1);
            const lines: string[] = [pc.dim("\nSubcommand Options:")];
            for (const sub of cmd.commands as Command[]) {
                const opts = sub.options.filter((o) => o.long !== "--help");
                if (opts.length === 0) {
                    continue;
                }
                lines.push(`\n  ${pc.bold(sub.name())}:`);
                for (const opt of opts) {
                    const [first, ...rest] = wrapDescription(describeOption(opt), available);
                    lines.push(`    ${pc.dim(opt.flags.padEnd(HELP_FLAG_WIDTH))} ${first}`);
                    for (const line of rest) {
                        lines.push(`    ${" ".repeat(HELP_FLAG_WIDTH)} ${line}`);
                    }
                }
            }
            return lines.join("\n");
        });
    }

    for (const sub of subs) {
        enhanceHelp(sub);
    }
}

/**
 * Build a CLI command string from a base command and options.
 * Converts camelCase keys to --kebab-case flags.
 * Skips undefined/false values. Boolean true = flag only. String = flag + quoted value.
 */
export function buildCommand(base: string, args: Record<string, string | boolean | undefined>): string {
    const parts = [base];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === false) {
            continue;
        }
        const flag = `--${key.replace(/([A-Z])/g, (_, c) => `-${c.toLowerCase()}`)}`;
        if (value === true) {
            parts.push(flag);
        } else {
            // Quote values that contain spaces
            parts.push(flag, value.includes(" ") ? `"${value}"` : value);
        }
    }
    return parts.join(" ");
}

/**
 * The running tool's Commander program, registered by `runTool`.
 *
 * `suggestCommand` rebuilds a command line out of raw argv, where `--verbose fetch` and
 * `--env test` are the same shape: one flag, one bare word. Only the flag's arity separates
 * them, and Commander already knows it. Every tool goes through `runTool`, which adds boolean
 * `-v/--verbose` and `--readme` to every program, so without this the suggestion swallowed the
 * subcommand whenever a user passed one (`tools timely -v login` suggested `tools timely -v
 * login login api-key`).
 */
let suggestProgram: Command | undefined;

export function setSuggestCommandProgram(command: Command | undefined): void {
    suggestProgram = command;
}

/**
 * Whether `flag` consumes the token after it. Without a registered program every flag falls
 * back to true, the behaviour from before registration existed.
 *
 * Two search modes, because the callers stand in different argv positions. `keepFlags` and
 * `remove` name options that live on child commands, so they search the whole tree. Leading
 * (pre-subcommand) positions pass `rootOnly`: only global options are legal there, and letting
 * a subcommand's same-named option answer would swallow the subcommand itself as the flag's
 * value — which is also why an unmatched flag answers false in that mode.
 */
function flagTakesValue(flag: string, opts?: { rootOnly?: boolean }): boolean {
    if (!suggestProgram) {
        return true;
    }

    // `-abc` is a cluster of short flags, and Commander lets only the last one take a value.
    const name = flag.length > 2 && /^-[^-]/.test(flag) ? `-${flag[flag.length - 1]}` : flag;

    const search = (cmd: Command, recurse: boolean): boolean | undefined => {
        for (const option of cmd.options) {
            if (option.short === name || option.long === name) {
                return option.required || option.optional;
            }
        }

        if (!recurse) {
            return undefined;
        }

        for (const sub of cmd.commands as Command[]) {
            const found = search(sub, true);
            if (found !== undefined) {
                return found;
            }
        }

        return undefined;
    };

    const found = search(suggestProgram, !opts?.rootOnly);

    if (found !== undefined) {
        return found;
    }

    return !opts?.rootOnly;
}

/** Split argv into the global options at its front and everything from the subcommand onward. */
function splitLeadingOptions(args: string[]): { leading: string[]; rest: string[] } {
    const leading: string[] = [];
    let i = 0;

    while (i < args.length) {
        const arg = args[i];
        // A bare word is the subcommand; everything after `--` is a payload for a wrapped
        // command (`tools task run --session x -- bash -c …`), never a global option.
        if (arg === "--" || !arg.startsWith("-")) {
            break;
        }

        leading.push(arg);
        i++;

        if (
            !arg.includes("=") &&
            flagTakesValue(arg, { rootOnly: true }) &&
            i < args.length &&
            !args[i].startsWith("-")
        ) {
            leading.push(args[i]);
            i++;
        }
    }

    return { leading, rest: args.slice(i) };
}

/**
 * Build a modified version of the current CLI command by adding/removing/replacing flags.
 * Uses process.argv to reconstruct the original command.
 *
 * @param toolName - The tool prefix (e.g., "tools azure-devops")
 * @param modifications - Flags to add, remove, or replace
 * @returns The modified command string with proper quoting
 */
export function suggestCommand(
    toolName: string,
    modifications: {
        add?: string[];
        remove?: string[];
        /** Replace the subcommand and its options, keeping global options */
        replaceCommand?: string[];
        /** Flag names to preserve from original argv when using replaceCommand (e.g., ["--session"]) */
        keepFlags?: string[];
        /**
         * Subcommand words that are already embedded in toolName and should be
         * stripped from the leading argv before assembling the suggestion.
         * Use when toolName includes the full sub-path, e.g.:
         *   toolName = "tools macos voice-memos transcribe"
         *   subcommand = ["macos", "voice-memos", "transcribe"]
         * Without this, process.argv would be appended verbatim and double the path.
         */
        subcommand?: string[];
    } = {}
): string {
    // process.argv = [bun, script, ...args]
    let args = process.argv.slice(2);

    // Strip leading subcommand tokens that are already in toolName. Global options may sit in
    // front of them (`tools stash -v save …`), so they are lifted out first and put back after;
    // matching at position 0 instead made `-v` suppress the strip and print `save` twice.
    if (modifications.subcommand?.length) {
        const sub = modifications.subcommand;
        const { leading, rest } = splitLeadingOptions(args);
        let matchLen = 0;

        for (let i = 0; i < sub.length && i < rest.length; i++) {
            if (rest[i] === sub[i]) {
                matchLen++;
            } else {
                break;
            }
        }

        args = [...leading, ...rest.slice(matchLen)];
    }

    // Replace subcommand: keep global options (flags before the command name),
    // then replace everything from the command name onward with new args
    if (modifications.replaceCommand) {
        const { leading, rest } = splitLeadingOptions(args);
        const globalArgs = [...leading];

        // Also preserve keepFlags from anywhere in the original args
        if (modifications.keepFlags?.length) {
            const keepSet = new Set(modifications.keepFlags);
            for (let j = 0; j < rest.length; j++) {
                const arg = rest[j];
                // Handle --flag=value syntax
                const eqIdx = arg.indexOf("=");
                const flagName = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
                if (keepSet.has(flagName)) {
                    globalArgs.push(arg);
                    // The combined `--flag=value` form already carries its value.
                    if (eqIdx < 0 && flagTakesValue(arg) && j + 1 < rest.length && !rest[j + 1].startsWith("-")) {
                        globalArgs.push(rest[j + 1]);
                        j++;
                    }
                }
            }
        }
        args = [...globalArgs, ...modifications.replaceCommand];
    }

    // Remove specified flags (and their values if they have one). Matches both bare flag form
    // (`--decision capture` → two argv entries) and combined form (`--decision=capture` → one
    // argv entry) when the caller passes the flag name without a value (e.g.
    // `remove: ["--decision"]`).
    if (modifications.remove?.length) {
        const removeSet = new Set(modifications.remove);
        const filtered: string[] = [];
        for (let i = 0; i < args.length; i++) {
            const eqIdx = args[i].indexOf("=");
            const flagName = eqIdx > 0 ? args[i].slice(0, eqIdx) : args[i];
            if (removeSet.has(flagName)) {
                // Skip the flag. If it was bare (no `=value`) and takes one, also skip its value.
                if (eqIdx < 0 && flagTakesValue(args[i]) && i + 1 < args.length && !args[i + 1].startsWith("-")) {
                    i++;
                }
                continue;
            }
            filtered.push(args[i]);
        }
        args = filtered;
    }

    // Add new flags
    if (modifications.add?.length) {
        args.push(...modifications.add);
    }

    // Quote args that contain spaces
    const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a));
    return `${toolName} ${quoted.join(" ")}`;
}

/**
 * Help text for a flag that takes a closed set of values and was passed empty,
 * or passed something outside the set. Callers print this and return with
 * exitCode 1 (non-TTY). TTY callers prompt instead.
 *
 * `given` matters: the same path handles an invalid value, and "requires a
 * value" contradicts the input the user actually typed (PR #343 review t32).
 */
export function formatMissingEnumHelp(opts: {
    flag: string;
    values: readonly string[];
    suggestion: string;
    given?: string;
}): string {
    const lead =
        opts.given === undefined || opts.given === ""
            ? `${opts.flag} requires a value.`
            : `${opts.flag} does not accept "${opts.given}".`;
    return `${lead} Possible: ${opts.values.join(", ")}\n${opts.suggestion}`;
}

/**
 * `formatMissingEnumHelp` plus a `suggestCommand` line that fills the first possible value.
 */
export function suggestEnumFlag(
    toolName: string,
    flag: string,
    values: readonly string[],
    modifications?: { subcommand?: string[]; given?: string }
): string {
    const example = values[0] ?? "<value>";
    return formatMissingEnumHelp({
        flag,
        values,
        given: modifications?.given,
        suggestion: suggestCommand(toolName, {
            remove: [flag],
            add: [flag, example],
            subcommand: modifications?.subcommand,
        }),
    });
}

const spawnProf = profiler.scope("spawn");

/** An argument that names or carries a credential (a header, a token flag) never reaches a log line. */
const SECRET_ARG = /authorization|token|password|secret|bearer|private-token/i;

/** A flag whose value is `user:password` (curl `-u`, `--user`, `-U`, `--proxy-user`). */
const USER_CREDENTIAL_FLAG = /^(?:-u|-U|--user|--proxy-user)$/;
/** The same flag with its value in the word: `--user=alice:pw`, `-ualice:pw`. */
const USER_CREDENTIAL_WORD = /^(?:--(?:proxy-)?user=|-[uU](?!-))[^:\s]+:/;

/** `git rev-parse --show-toplevel`, `gh pr view 42 --json …`: the command, its first arguments, credentials hidden. */
export function spawnLabel(cmd: string[]): string {
    const [program = "", ...args] = cmd;
    const name = program.split(/[\\/]/).pop() ?? program;
    const shown = args.slice(0, 6).map((arg, index) => {
        const masked = maskedArg(arg, args[index - 1]);
        return masked.length > 80 ? `${masked.slice(0, 77)}…` : masked;
    });
    return [name, ...shown, ...(args.length > 6 ? ["…"] : [])].join(" ");
}

/**
 * One argument as a log line or a failure record shows it: `***` when it names or carries a credential (the value
 * after `--token`, `-H` or `-u user:pw`), else the argument with every URL credential and token-shaped value in it
 * masked (`redactSecretsInText`: `https://alice:[redacted]@host/repo`).
 */
function maskedArg(arg: string, previous: string | undefined): string {
    if (
        SECRET_ARG.test(arg) ||
        isSecretFlag(previous) ||
        USER_CREDENTIAL_WORD.test(arg) ||
        (previous !== undefined && USER_CREDENTIAL_FLAG.test(previous) && /^[^:\s]+:/.test(arg))
    ) {
        return "***";
    }

    return redactSecretsInText(arg);
}

/** A flag that names a credential and takes its value as the next argument (`--password x`, `-H x`). */
function isSecretFlag(arg: string | undefined): boolean {
    return (
        arg?.startsWith("-") === true &&
        !arg.includes("=") &&
        (SECRET_ARG.test(arg) || arg === "-H" || arg === "--header")
    );
}

export interface ExecResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    /** Set when the caller's `timeout` killed the child. */
    timedOut?: boolean;
    /** Set when the output passed the caller's `maxOutputBytes`: it is cut there and the child was stopped. */
    truncated?: boolean;
}

/**
 * Env overrides for a child whose stdout is parsed: no forced colour. A terminal GenesisTools opens sets
 * CLICOLOR_FORCE=1 (`buildTerminalSpawnEnv`), a hub started from it inherits that, and gh then colours its JSON
 * even into a pipe; NO_COLOR does not override it (measured with gh 2.100.0, 2026-11-02: every PR list of the hub
 * failed with "unparsable gh output"). An undefined value removes the inherited variable.
 */
export const PLAIN_OUTPUT_ENV: Record<string, string | undefined> = {
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: undefined,
    GH_FORCE_TTY: undefined,
    CLICOLOR: "0",
    NO_COLOR: "1",
};

/**
 * A bound with the reason a command may run that long: the form a call uses when its command can outlast
 * {@link DEFAULT_EXEC_TIMEOUT_MS} by design (a clone, a rebase, a build). `ms: 0` is no deadline at all, legal only
 * here, with its reason.
 */
export interface ExecDeadline {
    ms: number;
    reason: string;
}

/**
 * The bound of every `exec` that names none, on the call or on its Executor. A wait has a deadline or it is a bug
 * (`.claude/rules/code.md`): before 2026-11-10 an `exec` without a timeout waited for its child forever.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * How long an expiry may spend writing its failure record (failures/deadline.ts) before the error is thrown anyway.
 * Tests shorten it.
 */
export const deadlineRecording = { boundMs: 2_000 };

/** `boundedCommand` has no unbounded mode, so `{ ms: 0, reason }` runs under its largest bound (24.8 days). */
const NO_DEADLINE_MS = 2_147_483_647;

/** Where a call's bound came from: its own options, its Executor's, or {@link DEFAULT_EXEC_TIMEOUT_MS}. */
export type ExecDeadlineSource = "call" | "executor" | "default";

export interface ResolvedExecDeadline {
    /** 0: no deadline. */
    ms: number;
    reason: string | null;
    source: ExecDeadlineSource;
}

/** One level of the bound: null when it names none (unset, or a bare number that is not positive). */
function deadlineOf(value: number | ExecDeadline | undefined): { ms: number; reason: string | null } | null {
    if (value === undefined) {
        return null;
    }

    if (typeof value === "number") {
        return value > 0 ? { ms: value, reason: null } : null;
    }

    if (!Number.isFinite(value.ms) || value.ms < 0) {
        throw new Error(`timeout.ms must be 0 or a positive number of milliseconds, not ${value.ms}`);
    }

    const reason = value.reason.trim();

    if (value.ms === 0 && !reason) {
        throw new Error("timeout { ms: 0 } removes the deadline and needs a reason that says why");
    }

    return { ms: value.ms, reason: reason || null };
}

/** The bound a call runs under: the call's, then its Executor's, then the default. */
export function resolveExecDeadline(
    call: number | ExecDeadline | undefined,
    executor: number | ExecDeadline | undefined
): ResolvedExecDeadline {
    const fromCall = deadlineOf(call);

    if (fromCall) {
        return { ...fromCall, source: "call" };
    }

    const fromExecutor = deadlineOf(executor);

    if (fromExecutor) {
        return { ...fromExecutor, source: "executor" };
    }

    return { ms: DEFAULT_EXEC_TIMEOUT_MS, reason: null, source: "default" };
}

/** Every argument of `cmd`, with the credentials hidden as in {@link spawnLabel}: what a deadline record keeps. */
export function maskedArgv(cmd: string[]): string[] {
    return cmd.map((arg, index) => (index > 0 ? maskedArg(arg, cmd[index - 1]) : arg));
}

/** The sentence an expiry throws and records: the command, the bound, where the bound came from, and the fix. */
export function deadlineMessage(deadline: ResolvedExecDeadline, cmd: string[]): string {
    const command = maskedArgv(cmd).join(" ");
    const reason = deadline.reason ? `: ${deadline.reason}` : "";

    if (deadline.source === "default") {
        return (
            `Command timed out after ${deadline.ms}ms (the default deadline of an Executor call): ${command}. ` +
            "A command that can run longer by design passes timeout: { ms, reason }."
        );
    }

    const source = deadline.source === "call" ? `this call's bound${reason}` : `its Executor's bound${reason}`;

    return `Command timed out after ${deadline.ms}ms (${source}): ${command}`;
}

export interface ExecutorOptions {
    /** Base command prefix (e.g., "git" → all calls prepend "git") */
    prefix?: string;
    /**
     * The bound of every call of this executor that names none; a call's own `timeout` wins. Unset: the default
     * ({@link DEFAULT_EXEC_TIMEOUT_MS}).
     */
    timeout?: number | ExecDeadline;
    /** Working directory for all commands */
    cwd?: string;
    /** Environment variables (merged on top of process.env) */
    env?: Record<string, string | undefined>;
    /** Enable verbose logging of commands (default: false) */
    verbose?: boolean;
    /** Enable debug logging of stdout/stderr (default: false) */
    debug?: boolean;
    /** Custom label for log output (default: prefix or "exec") */
    label?: string;
}

export interface ExecCallOptions {
    /** Override working directory for this call */
    cwd?: string;
    /** Override/extend environment variables for this call */
    env?: Record<string, string | undefined>;
    /**
     * The bound of this call: the process group is killed and the promise rejects on expiry. A number is
     * milliseconds; a bare 0 or none means the Executor's bound, else {@link DEFAULT_EXEC_TIMEOUT_MS}. A command that
     * can run longer by design says why: `{ ms: 600_000, reason: "a clone of a large repository" }`; `{ ms: 0, reason }`
     * is no deadline.
     */
    timeout?: number | ExecDeadline;
    /**
     * `false` returns stdout and stderr exactly as the command wrote them. Default `true` trims both. NUL-delimited
     * output (`git ls-files -z`) needs `false`: a leading space or newline is part of the first path.
     */
    trim?: boolean;
}

/**
 * Writes the failure record of an expiry (failures/deadline.ts), loaded only here so no tool pays for it at startup.
 * Bounded by `deadlineRecording.boundMs`: the thrown error never waits longer, and a record that fails is a debug line.
 * The record step starts no process through an Executor, so an expiry cannot recurse.
 */
async function recordExpiry(expiry: DeadlineExpiry): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineRecording.boundMs);
    });
    const record = import("./failures/deadline")
        .then((deadline) => deadline.recordDeadline(expiry))
        .then(
            () => undefined,
            (error: unknown) => {
                logger.debug({ error }, "exec: the deadline record was not written");
            }
        );

    await Promise.race([record, bound]);
    clearTimeout(timer);
}

export class Executor {
    private prefix: string | undefined;
    private cwd: string;
    private env: Record<string, string | undefined> | undefined;
    private timeout: number | ExecDeadline | undefined;
    verbose: boolean;
    debug: boolean;
    private label: string;

    constructor(options: ExecutorOptions = {}) {
        this.prefix = options.prefix;
        this.timeout = options.timeout;
        this.cwd = options.cwd ?? process.cwd();
        this.env = options.env;
        this.verbose = options.verbose ?? false;
        this.debug = options.debug ?? false;
        this.label = options.label ?? options.prefix ?? "exec";
    }

    /** Set working directory */
    setCwd(cwd: string): void {
        this.cwd = cwd;
    }

    /** Get current working directory */
    getCwd(): string {
        return this.cwd;
    }

    /**
     * Build the merged environment for a spawn call.
     * Per-call env overrides constructor env, both layered on top of process.env.
     * Returns undefined when no custom env is configured (inherits process.env automatically).
     */
    private buildEnv(callEnv?: Record<string, string | undefined>): Record<string, string | undefined> | undefined {
        if (!this.env && !callEnv) {
            return undefined;
        }

        return {
            ...env.getProcessEnv(),
            ...this.env,
            ...callEnv,
        };
    }

    /**
     * Execute a command and capture output, always under a deadline (`ExecCallOptions.timeout`): the call's bound,
     * else the Executor's, else {@link DEFAULT_EXEC_TIMEOUT_MS}. On expiry the whole process group is killed and the
     * call throws.
     * If prefix is set, args are prepended with it.
     * e.g., new Executor({ prefix: "git" }).exec(["status"]) → runs "git status"
     */
    async exec(args: string[], options?: ExecCallOptions): Promise<ExecResult> {
        const cmd = this.prefix ? [this.prefix, ...args] : args;
        const cwd = options?.cwd ?? this.cwd;
        const env = this.buildEnv(options?.env);
        const deadline = resolveExecDeadline(options?.timeout, this.timeout);
        // Taken before the first await, while the caller is still on the stack: an expiry record names the call site.
        const callSite = new Error("exec call site").stack ?? null;
        const finish = (text: string): string => (options?.trim === false ? text : text.trim());

        if (this.verbose) {
            out.println(pc.gray(`  $ ${cmd.join(" ")}`));
        }

        const stopTimer = spawnProf.start(spawnLabel(cmd));
        const started = performance.now();
        const bounded = await boundedCommand({
            command: cmd,
            timeoutMs: deadline.ms === 0 ? NO_DEADLINE_MS : deadline.ms,
            cwd,
            environment: env,
            maxBufferBytes: 64 * 1024 * 1024,
        });

        if (bounded.error) {
            stopTimer(bounded.error.code === "ETIMEDOUT" ? "timeout" : "error");

            if (bounded.error.code === "ETIMEDOUT") {
                const message = deadlineMessage(deadline, cmd);
                logger.warn(
                    {
                        command: spawnLabel(cmd),
                        timeoutMs: deadline.ms,
                        source: deadline.source,
                        reason: deadline.reason,
                    },
                    message
                );
                await recordExpiry({
                    child: {
                        command: maskedArgv(cmd),
                        cwd,
                        timeoutMs: deadline.ms,
                        defaulted: deadline.source === "default",
                        reason: deadline.reason,
                    },
                    message,
                    durationMs: performance.now() - started,
                    stack: callSite,
                });
                throw new Error(message);
            }

            throw bounded.error;
        }

        const exitCode = bounded.status ?? 1;
        stopTimer(`exit=${exitCode}`);
        const result: ExecResult = {
            success: exitCode === 0,
            stdout: finish(bounded.stdout),
            stderr: finish(bounded.stderr),
            exitCode,
        };

        if (this.debug) {
            if (result.stdout) {
                out.println(pc.dim(`  [${this.label}:out] ${result.stdout.substring(0, 200)}`));
            }
            if (result.stderr) {
                out.println(pc.dim(`  [${this.label}:err] ${result.stderr.substring(0, 200)}`));
            }
            if (!result.success) {
                out.println(pc.red(`  [${this.label}] exit ${result.exitCode}`));
            }
        }

        return result;
    }

    /**
     * Execute a command with inherited stdio (interactive).
     * User sees the command's output directly. It has no deadline on purpose: a person may be answering the child
     * (a prompt, an editor, a pager), and only that person knows when it is done.
     */
    async execInteractive(args: string[], options?: Pick<ExecCallOptions, "cwd" | "env">): Promise<ExecResult> {
        const cmd = this.prefix ? [this.prefix, ...args] : args;
        const cwd = options?.cwd ?? this.cwd;
        const env = this.buildEnv(options?.env);

        if (this.verbose) {
            out.println(pc.cyan(`  $ ${cmd.join(" ")}`));
        }

        const proc = Bun.spawn({
            cmd,
            cwd,
            env,
            stdio: ["inherit", "inherit", "inherit"],
        });

        const exitCode = await proc.exited;

        return {
            success: exitCode === 0,
            stdout: "",
            stderr: "",
            exitCode,
        };
    }

    /**
     * Execute and throw on failure (a non-zero exit, or the deadline of `options.timeout`, as in {@link exec}).
     */
    async execOrThrow(args: string[], errorMsg?: string, options?: ExecCallOptions): Promise<ExecResult> {
        const result = await this.exec(args, options);
        if (!result.success) {
            // The failures log keeps a thrown message; it masks URL credentials, not the value of `-u user:pw`.
            const command = maskedArgv(this.prefix ? [this.prefix, ...args] : args).join(" ");
            throw new Error(errorMsg ?? `Command failed: ${command}\n${result.stderr}`);
        }
        return result;
    }
}
