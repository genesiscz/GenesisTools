import type { Command } from "commander";
import pc from "picocolors";

/**
 * Enhance a Commander program with better help UX:
 * - Shows help after errors (e.g. too many arguments)
 * - Expands subcommand options in the parent's help output
 * - Recurses into nested subcommands
 *
 * Call once on the root program after all commands are registered.
 */
export function enhanceHelp(cmd: Command): void {
    cmd.showHelpAfterError(true);

    const subs = cmd.commands as Command[];
    if (subs.length > 0) {
        cmd.addHelpText("after", () => {
            const lines: string[] = [pc.dim("\nSubcommand Options:")];
            for (const sub of cmd.commands as Command[]) {
                const opts = sub.options.filter((o) => o.long !== "--help");
                if (opts.length === 0) {
                    continue;
                }
                lines.push(`\n  ${pc.bold(sub.name())}:`);
                for (const opt of opts) {
                    lines.push(`    ${pc.dim(opt.flags.padEnd(30))} ${opt.description}`);
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
    } = {}
): string {
    // process.argv = [bun, script, ...args]
    let args = process.argv.slice(2);

    // Replace subcommand: keep global options (flags before the command name),
    // then replace everything from the command name onward with new args
    if (modifications.replaceCommand) {
        const originalArgs = args;
        const globalArgs: string[] = [];
        let i = 0;
        while (i < args.length) {
            if (args[i].startsWith("-")) {
                globalArgs.push(args[i]);
                // If next arg doesn't start with -, it's the flag's value
                if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                    globalArgs.push(args[i + 1]);
                    i += 2;
                } else {
                    i++;
                }
            } else {
                break; // Found the subcommand
            }
        }
        // Also preserve keepFlags from anywhere in the original args
        if (modifications.keepFlags?.length) {
            const keepSet = new Set(modifications.keepFlags);
            for (let j = i; j < originalArgs.length; j++) {
                const arg = originalArgs[j];
                // Handle --flag=value syntax
                const eqIdx = arg.indexOf("=");
                const flagName = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
                if (keepSet.has(flagName)) {
                    if (eqIdx > 0) {
                        // Combined form: --flag=value
                        globalArgs.push(arg);
                    } else {
                        globalArgs.push(arg);
                        if (j + 1 < originalArgs.length && !originalArgs[j + 1].startsWith("-")) {
                            globalArgs.push(originalArgs[j + 1]);
                            j++;
                        }
                    }
                }
            }
        }
        args = [...globalArgs, ...modifications.replaceCommand];
    }

    // Remove specified flags (and their values if they have one)
    if (modifications.remove?.length) {
        const removeSet = new Set(modifications.remove);
        const filtered: string[] = [];
        for (let i = 0; i < args.length; i++) {
            if (removeSet.has(args[i])) {
                // Skip the flag — also skip its value if next arg doesn't start with --
                if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
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
            ...process.env,
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
            console.log(pc.gray(`  $ ${cmd.join(" ")}`));
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

            const timeoutResult = await Promise.race([
                collectOutput.then((r) => ({ type: "done" as const, value: r })),
                new Promise<{ type: "timeout" }>((resolve) =>
                    setTimeout(() => resolve({ type: "timeout" }), timeoutMs)
                ),
            ]);

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
                console.log(pc.dim(`  [${this.label}:out] ${result.stdout.substring(0, 200)}`));
            }
            if (result.stderr) {
                console.log(pc.dim(`  [${this.label}:err] ${result.stderr.substring(0, 200)}`));
            }
            if (!result.success) {
                console.log(pc.red(`  [${this.label}] exit ${exitCode}`));
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
            console.log(pc.cyan(`  $ ${cmd.join(" ")}`));
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
