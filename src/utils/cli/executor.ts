import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

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
function describeOption(option: { description: string; defaultValue?: unknown; defaultValueDescription?: string }) {
    if (option.defaultValue === undefined) {
        return option.description;
    }

    const shown = option.defaultValueDescription ?? SafeJSON.stringify(option.defaultValue);

    return `${option.description} (default: ${shown})`;
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

export interface ExecResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface ExecutorOptions {
    /** Base command prefix (e.g., "git" → all calls prepend "git") */
    prefix?: string;
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
    /** Timeout in milliseconds. Process is killed and promise rejects on expiry. */
    timeout?: number;
}

export class Executor {
    private prefix: string | undefined;
    private cwd: string;
    private env: Record<string, string | undefined> | undefined;
    verbose: boolean;
    debug: boolean;
    private label: string;

    constructor(options: ExecutorOptions = {}) {
        this.prefix = options.prefix;
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
     * Execute a command and capture output.
     * If prefix is set, args are prepended with it.
     * e.g., new Executor({ prefix: "git" }).exec(["status"]) → runs "git status"
     */
    async exec(args: string[], options?: ExecCallOptions): Promise<ExecResult> {
        const cmd = this.prefix ? [this.prefix, ...args] : args;
        const cwd = options?.cwd ?? this.cwd;
        const env = this.buildEnv(options?.env);

        if (this.verbose) {
            out.println(pc.gray(`  $ ${cmd.join(" ")}`));
        }

        const proc = Bun.spawn({
            cmd,
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const collectOutput = Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        let stdout: string;
        let stderr: string;
        let exitCode: number;

        if (options?.timeout) {
            const timeoutMs = options.timeout;
            // Cleared after the race — an uncleared timer keeps the event loop
            // (and the whole CLI process) alive for the full timeout after exit.
            let timer: ReturnType<typeof setTimeout> | undefined;

            const timeoutResult = await Promise.race([
                collectOutput.then((r) => ({ type: "done" as const, value: r })),
                new Promise<{ type: "timeout" }>((resolve) => {
                    timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
                }),
            ]);
            clearTimeout(timer);

            if (timeoutResult.type === "timeout") {
                proc.kill();
                await proc.exited;
                throw new Error(`Command timed out after ${timeoutMs}ms: ${cmd.join(" ")}`);
            }

            [stdout, stderr, exitCode] = timeoutResult.value;
        } else {
            [stdout, stderr, exitCode] = await collectOutput;
        }

        const result: ExecResult = {
            success: exitCode === 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
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
                out.println(pc.red(`  [${this.label}] exit ${exitCode}`));
            }
        }

        return result;
    }

    /**
     * Execute a command with inherited stdio (interactive).
     * User sees the command's output directly.
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
     * Execute and throw on failure.
     */
    async execOrThrow(args: string[], errorMsg?: string): Promise<ExecResult> {
        const result = await this.exec(args);
        if (!result.success) {
            throw new Error(
                errorMsg ?? `Command failed: ${this.prefix ? `${this.prefix} ` : ""}${args.join(" ")}\n${result.stderr}`
            );
        }
        return result;
    }
}
