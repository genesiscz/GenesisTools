import { resolve } from "node:path";
import { format } from "node:util";
import { moduleDir, requireSibling } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { currentTraceId } from "@genesiscz/utils/trace";
import { redactSecretsInText } from "@genesiscz/utils/transclude/redact";
import { appendFailure, type FailureCaller, type FailureKind, type ToolFailure } from "./record";
import { takeRunId } from "./run-id";

const TAIL_CHARS = 4000;
const TOOLS_ROOT = resolve(moduleDir(import.meta), "../../../..");
const SECRET_WORD = "(?:token|secret|password|passwd|api[-_]?key|auth|cookie|credential)";
const SECRET_FLAG = new RegExp(`^--?[\\w-]*${SECRET_WORD}[\\w-]*$`, "i");
/** A positional argument whose declared name is secret-shaped (`[secret]`) takes a secret value. */
const SECRET_ARGUMENT = new RegExp(SECRET_WORD, "i");
/** Commander's own refusals; each starts a stderr write with `error: `. */
const USAGE_LINE =
    /^error: (?:unknown option|unknown command|missing required argument|option .+ argument missing|required option|too many arguments|option .+ argument .+ is invalid|command-argument value .+ is invalid|option .+ cannot be used with)/m;

interface Noted {
    kind: "usage" | "error" | "crash";
    error: unknown;
    fatal: boolean;
}

interface Run {
    tool: string;
    argv: string[];
    commandPath: () => string | null;
    /** The secret flags and argv words of the command that ran (`-t` for `--token`); asked only when writing. */
    secrets: () => ArgvSecrets;
    /** Who ran the tool, asked only when a failure is written (agent-caller.ts unless a test injects one). */
    caller: () => FailureCaller | null;
    stderr: string;
    /** Only read for a JSON error object; never stored, since stdout is the tool's result. */
    stdout: string;
    noted: Noted | null;
    ended: boolean;
    /** The `tools` wrapper's id for this run, copied into every record so the wrapper never records it twice. */
    runId: string | undefined;
}

let run: Run | null = null;

/** What the command definition says is secret in one argv, beyond what a flag's name shows. */
export interface ArgvSecrets {
    /** Every flag, short and long, of a secret-named option on the commands the run reaches (`-t` for `--token`). */
    flags: string[];
    /** The argv indexes of a declared secret option's value (even `-x…`) and of a secret-named argument's value. */
    indexes: number[];
    /** A secret value attached inside a group of short flags (`-vtx`): the word's index and where the value starts. */
    attached?: { index: number; at: number }[];
}

/** What a message, stack or stderr tail becomes when it echoes a declared secret too short to replace safely. */
export const WITHHELD_TEXT = "[withheld: it echoes a short secret value]";

/**
 * Masks the value of a secret-named flag (`--token x`, `--api-key=x`), of a flag the command declares for a
 * secret-named option (`-t x` and `-tx` when `-t` is `--token`), every word `secrets.indexes` names, every value
 * `secrets.attached` names (`-vtx`), and any secret-shaped argument.
 */
export function redactArgv(args: readonly string[], secrets: Partial<ArgvSecrets> = {}): string[] {
    const secretFlags = secrets.flags ?? [];
    const secretIndexes = new Set(secrets.indexes ?? []);
    const attachedAt = new Map((secrets.attached ?? []).map(({ index, at }) => [index, at]));
    const isSecret = (flag: string) => SECRET_FLAG.test(flag) || secretFlags.includes(flag);
    const shorts = secretFlags.filter((flag) => /^-[^-]$/.test(flag));

    return args.map((arg, index) => {
        if (secretIndexes.has(index)) {
            return "[redacted]";
        }

        const valueAt = attachedAt.get(index);
        if (valueAt !== undefined) {
            return `${arg.slice(0, valueAt)}[redacted]`;
        }

        const assigned = /^(--?[\w-]+)=/.exec(arg);
        if (assigned && isSecret(assigned[1])) {
            return `${assigned[1]}=[redacted]`;
        }

        if (index > 0 && isSecret(args[index - 1]) && !arg.startsWith("-")) {
            return "[redacted]";
        }

        const attached = shorts.find((flag) => arg.length > 2 && arg.startsWith(flag));
        if (attached) {
            return `${attached}[redacted]`;
        }

        return redactSecretsInText(arg);
    });
}

/** The argument values `redactArgv` masks, so the same values can be masked where a message or stderr echoes them. */
function secretValues(args: readonly string[], secrets: Partial<ArgvSecrets>): string[] {
    const masked = redactArgv(args, secrets);
    return args
        .flatMap((arg, index) => {
            if (masked[index] === arg) {
                return [];
            }

            const kept = masked[index].replace(/\[redacted\]$/, "");
            return [arg.startsWith(kept) ? arg.slice(kept.length) : arg];
        })
        .filter((value) => value.length > 0);
}

/**
 * `redactSecretsInText`, plus every `--secret-flag=value` and every secret argument value the text echoes. A value
 * shorter than four characters would mask unrelated text wherever it occurs, so a text that still echoes one is
 * withheld whole ({@link WITHHELD_TEXT}).
 */
export function redactRunText(text: string, args: readonly string[], secrets: Partial<ArgvSecrets> = {}): string {
    const secretFlags = secrets.flags ?? [];
    let out = redactSecretsInText(text).replace(/(--?[\w-]+)=([^\s'"`]+)/g, (whole, flag: string) =>
        SECRET_FLAG.test(flag) || secretFlags.includes(flag) ? `${flag}=[redacted]` : whole
    );

    const values = secretValues(args, secrets);
    for (const value of values.filter((candidate) => candidate.length >= 4)) {
        out = out.split(value).join("[redacted]");
    }

    if (values.some((value) => value.length < 4 && out.includes(value))) {
        return WITHHELD_TEXT;
    }

    return out;
}

interface OptionNode {
    short?: string;
    long?: string;
    /** `<value>`: the next word is the value, even one that starts with a dash. */
    required?: boolean;
    /** `[value]`: the next word is the value unless it starts with a dash. */
    optional?: boolean;
}

interface ArgumentNode {
    name(): string;
    variadic?: boolean;
}

interface CommandNode {
    name(): string;
    aliases(): string[];
    readonly commands: readonly CommandNode[];
    readonly options: readonly OptionNode[];
    readonly registeredArguments?: readonly ArgumentNode[];
}

function isSecretOption(option: OptionNode): boolean {
    return option.long !== undefined && SECRET_FLAG.test(option.long);
}

/**
 * The option a flag word ends with, whether its value is the next word, and where a value attached to it starts
 * (`-vtx`: 3). Null for a flag no command declares.
 */
function flagOption(
    word: string,
    chain: readonly CommandNode[]
): { option: OptionNode; valueNext: boolean; valueAt?: number } | null {
    const find = (flag: string) =>
        chain.flatMap((command) => command.options).find((option) => option.short === flag || option.long === flag);

    if (word.startsWith("--")) {
        const option = find(word.split("=")[0]);
        return option ? { option, valueNext: !word.includes("=") } : null;
    }

    // `-vt` is `-v -t` until one flag takes a value; the rest of the word is then that value.
    for (let at = 1; at < word.length; at++) {
        const option = find(`-${word[at]}`);
        if (!option) {
            return null;
        }

        if (at === word.length - 1) {
            return { option, valueNext: true };
        }

        if (option.required || option.optional) {
            return { option, valueNext: false, valueAt: at + 1 };
        }
    }

    return null;
}

/** A command and every subcommand under it, at any depth. */
function commandsUnder(command: CommandNode): CommandNode[] {
    return [command, ...command.commands.flatMap(commandsUnder)];
}

function secretFlagsOf(commands: readonly CommandNode[]): string[] {
    const flags = commands.flatMap((command) =>
        command.options
            .filter(isSecretOption)
            .flatMap((option) => [option.short, option.long].filter((flag): flag is string => flag !== undefined))
    );
    return [...new Set(flags)];
}

function takesSecret(command: CommandNode): boolean {
    return (
        command.options.some(isSecretOption) ||
        (command.registeredArguments ?? []).some((argument) => SECRET_ARGUMENT.test(argument.name()))
    );
}

interface WalkedArgv {
    chain: CommandNode[];
    secretIndexes: number[];
    attached: { index: number; at: number }[];
    /** The index of the first flag no command declares; commander refuses that line. Null when every flag is known. */
    refusedAt: number | null;
}

/**
 * Reads `args` the way commander does: options of every command reached so far may come anywhere (`-v` before the
 * subcommand), an option's value is skipped, and the first operand that names no subcommand ends the chain. Stops at
 * a flag no command declares, since commander refuses that line and what follows has no known shape.
 */
function walkArgv(program: CommandNode, args: readonly string[]): WalkedArgv {
    const chain = [program];
    const secretIndexes: number[] = [];
    const attached: { index: number; at: number }[] = [];
    const operands: number[] = [];
    let commandsDone = false;
    let refusedAt: number | null = null;

    for (let index = 0; index < args.length; index++) {
        const word = args[index];
        if (word === "--") {
            for (let rest = index + 1; rest < args.length; rest++) {
                operands.push(rest);
            }

            break;
        }

        if (word.startsWith("-") && word !== "-") {
            const found = flagOption(word, chain);
            if (!found) {
                refusedAt = index;
                break;
            }

            const next = args[index + 1];
            const { option } = found;
            if (found.valueAt !== undefined && isSecretOption(option)) {
                attached.push({ index, at: found.valueAt });
            }

            if (
                found.valueNext &&
                next !== undefined &&
                (option.required || (option.optional && !next.startsWith("-")))
            ) {
                index++;
                if (isSecretOption(option)) {
                    secretIndexes.push(index);
                }
            }

            continue;
        }

        if (!commandsDone) {
            const current = chain[chain.length - 1];
            const sub = current.commands.find((command) => command.name() === word || command.aliases().includes(word));
            if (sub) {
                chain.push(sub);
                continue;
            }

            commandsDone = true;
        }

        operands.push(index);
    }

    const declared = chain[chain.length - 1].registeredArguments ?? [];
    const last = declared[declared.length - 1];
    operands.forEach((argIndex, position) => {
        const argument = position < declared.length ? declared[position] : last?.variadic ? last : undefined;
        if (argument && SECRET_ARGUMENT.test(argument.name())) {
            secretIndexes.push(argIndex);
        }
    });

    return { chain, secretIndexes, attached, refusedAt };
}

/** `ai usage sessions` for `tools ai usage sessions --bad`: the deepest subcommand the words name. */
export function commandPathFromArgv(program: CommandNode, args: readonly string[]): string {
    return walkArgv(program, args)
        .chain.map((command) => command.name())
        .join(" ");
}

/**
 * The flags of every secret-named option on the commands `args` reaches (`-t` for `--token`), and the argv
 * indexes of their values and of a secret-named argument's value (`<path> [secret]`).
 *
 * A line with a flag no command declares has no known shape past that flag. When a command at or under the deepest
 * one reached takes a secret, every later word that is not a flag counts as secret, and the flags of every secret
 * option under it count too: a refused line is still recorded, and its secret must not be.
 */
export function secretsFromArgv(program: CommandNode, args: readonly string[]): ArgvSecrets {
    const { chain, secretIndexes, attached, refusedAt } = walkArgv(program, args);
    const below = refusedAt === null ? [] : commandsUnder(chain[chain.length - 1]);
    if (refusedAt === null || !below.some(takesSecret)) {
        return { flags: secretFlagsOf(chain), indexes: secretIndexes, attached };
    }

    const rest = args.flatMap((word, index) => (index > refusedAt && !word.startsWith("-") ? [index] : []));
    return {
        flags: secretFlagsOf([...chain, ...below]),
        indexes: [...new Set([...secretIndexes, ...rest])],
        attached,
    };
}

/** What a run that ends with `exitCode` was. Null when it is not a failure. */
export function classifyExit({
    exitCode,
    noted,
    stderrTail,
}: {
    exitCode: number;
    noted: Noted | null;
    stderrTail: string;
}): FailureKind | null {
    if (noted?.kind === "crash" && noted.fatal) {
        return "crash";
    }

    if (exitCode === 0) {
        return null;
    }

    if (exitCode === 130 || exitCode === 143) {
        return "interrupt";
    }

    if (noted?.kind === "error" || noted?.kind === "usage") {
        return noted.kind;
    }

    if (USAGE_LINE.test(stderrTail) || /^Usage: /.test(stderrTail.trimStart())) {
        return "usage";
    }

    return "exit";
}

/** The line a reader needs: commander's `error:` line, else the last non-empty stderr line. */
export function messageOfTail(tail: string): string | null {
    const usage = USAGE_LINE.exec(tail);
    if (usage) {
        const end = tail.indexOf("\n", usage.index);
        return tail.slice(usage.index, end === -1 ? undefined : end);
    }

    if (/^Usage: /.test(tail.trimStart())) {
        return "no subcommand given; the help was printed";
    }

    // clack frames each line with `│` and marks an error with `■`; `ERROR:` is runTool's own prefix.
    const lines = tail
        .split("\n")
        .map((line) => line.replace(/^[│\s]+/, "").trim())
        .filter(Boolean);
    // Not findLast: the dashboard tsconfigs that reach src/utils compile against an older lib.
    const marked = [...lines].reverse().find((line) => /^(?:■|✖|✗|×|ERROR:|Error:|error:)/.test(line));
    return (marked ?? lines.at(-1))?.replace(/^(?:■|✖|✗|×)\s*/, "") ?? null;
}

/**
 * The message of the last JSON error line a `--json` run printed: `{"type":"error","message":…}`,
 * `{"error":"…"}` or `{"error":{"message":"…"}}` (du index, ai usage and others report failures on stdout).
 */
export function jsonErrorMessage(stdoutTail: string): string | null {
    const lines = stdoutTail.split("\n").filter((line) => line.trimStart().startsWith("{"));

    for (const line of lines.reverse()) {
        let value: unknown;
        try {
            value = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            logger.debug({ error }, "failures: a stdout line looked like JSON and was not");
            continue;
        }

        if (typeof value !== "object" || value === null) {
            continue;
        }

        const record = value as { type?: unknown; message?: unknown; error?: unknown };
        if (record.type === "error" && typeof record.message === "string") {
            return record.message;
        }

        if (typeof record.error === "string") {
            return record.error;
        }

        if (typeof record.error === "object" && record.error !== null) {
            const nested = (record.error as { message?: unknown }).message;
            if (typeof nested === "string") {
                return nested;
            }
        }
    }

    return null;
}

function text(chunk: unknown): string {
    return typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : "";
}

function remember(chunk: unknown): void {
    if (run) {
        run.stderr = (run.stderr + text(chunk)).slice(-TAIL_CHARS);
    }
}

function tapStderr(): void {
    const write = process.stderr.write;
    process.stderr.write = function (this: NodeJS.WriteStream, ...args: Parameters<typeof write>) {
        remember(args[0]);
        return Reflect.apply(write, this, args);
    } as typeof write;

    const writeOut = process.stdout.write;
    process.stdout.write = function (this: NodeJS.WriteStream, ...args: Parameters<typeof writeOut>) {
        if (run) {
            run.stdout = (run.stdout + text(args[0])).slice(-TAIL_CHARS);
        }

        return Reflect.apply(writeOut, this, args);
    } as typeof writeOut;

    // Bun's console.error and console.warn write to fd 2 without process.stderr.write.
    const consoleError = console.error;
    const consoleWarn = console.warn;
    console.error = (...data: unknown[]) => {
        remember(`${format(...data)}\n`);
        consoleError(...data);
    };
    console.warn = (...data: unknown[]) => {
        remember(`${format(...data)}\n`);
        consoleWarn(...data);
    };
}

/**
 * agent-caller.ts, loaded on a failure only (the exit event is synchronous, so the load is too). The path is built at
 * run time so neither a bundler nor the type checker follows it into the agent runtime. A copy of these helpers
 * without that module records failures with no caller.
 */
export function agentCaller(): FailureCaller | null {
    const loaded: unknown = requireSibling(import.meta, "agent-caller");
    const lookup = (loaded as { agentFailureCaller?: unknown } | null)?.agentFailureCaller;
    if (typeof lookup !== "function") {
        return null;
    }

    const found: unknown = lookup();
    return typeof found === "object" && found !== null && "agent" in found ? (found as FailureCaller) : null;
}

function caller(): FailureCaller | null {
    try {
        return run?.caller() ?? null;
    } catch (error) {
        logger.debug({ error }, "failures: no caller context");
        return null;
    }
}

function write(kind: FailureKind, exitCode: number | null, fatal: boolean): void {
    if (!run) {
        return;
    }

    try {
        const error = run.noted?.error;
        const err = error instanceof Error ? error : null;
        const secrets = run.secrets();
        const redact = (text: string) => redactRunText(text, run?.argv ?? [], secrets);
        const tail = redact(stripAnsi(run.stderr)).trim();
        const message = err
            ? err.message
            : error !== undefined && error !== null
              ? String(error)
              : (jsonErrorMessage(run.stdout) ?? messageOfTail(tail));
        const failure: ToolFailure = {
            v: 1,
            id: `${Date.now().toString(36)}-${process.pid}`,
            at: new Date().toISOString(),
            kind,
            tool: run.tool,
            command: run.commandPath()?.replace(/^tools /, "") ?? null,
            argv: redactArgv(run.argv, secrets),
            exitCode,
            message: message ? redact(stripAnsi(message)).slice(0, 2000) : null,
            errorName: err?.name ?? null,
            stack: err?.stack ? redact(err.stack).slice(0, 8000) : null,
            stderrTail: tail || null,
            fatal,
            durationMs: Math.round(performance.now()),
            pid: process.pid,
            ppid: process.ppid,
            cwd: process.cwd(),
            traceId: currentTraceId() ?? null,
            toolsRoot: TOOLS_ROOT,
            caller: caller(),
            ...(run.runId ? { runId: run.runId } : {}),
        };
        appendFailure(failure);
    } catch (writeError) {
        logger.debug({ error: writeError }, "failures: the record was not written");
    }
}

function finish(code: number): void {
    if (!run || run.ended) {
        return;
    }

    run.ended = true;
    // A crash another listener took is still pending here when that listener ended the process (ai-proxy's
    // `process.exit(1)`): it was fatal after all, and it is the cause of this exit.
    if (run.noted?.kind === "crash") {
        run.noted = { ...run.noted, fatal: true };
    }

    const exitCode = code || (typeof process.exitCode === "number" ? process.exitCode : 0);
    const kind = classifyExit({ exitCode, noted: run.noted, stderrTail: stripAnsi(run.stderr) });
    if (kind) {
        write(kind, exitCode, true);
    }
}

/**
 * A crash. One some other listener handles is written once that listener has returned and the process went on;
 * a listener that ends the process instead leaves it to the exit hook, which writes it as the fatal cause.
 */
function noteCrash(error: unknown, fatal: boolean): void {
    if (!run) {
        return;
    }

    const noted: Noted = { kind: "crash", error, fatal };
    run.noted = noted;
    if (!fatal) {
        setImmediate(() => {
            if (run && !run.ended && run.noted === noted) {
                write("crash", null, false);
                run.noted = null;
            }
        });
    }
}

function onRejection(reason: unknown): void {
    const handledElsewhere = process.listenerCount("unhandledRejection") > 1;
    noteCrash(reason, !handledElsewhere);
    if (handledElsewhere) {
        return;
    }

    // Bun ends the process on an unhandled rejection unless a listener exists; this listener keeps that ending.
    logger.debug({ err: reason }, "unhandled rejection");
    process.stderr.write(`ERROR: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
    process.exit(1);
}

/** A parser of its own refused the command line (an entry point without commander). */
export function noteUsageError(message: string): void {
    if (run) {
        run.noted = { kind: "usage", error: message, fatal: true };
    }
}

/** The action threw and runTool printed it. */
export function noteToolError(error: unknown): void {
    if (run) {
        run.noted = { kind: "error", error, fatal: true };
    }
}

/**
 * Records every failed run of this process into `~/.genesis-tools/logs/<date>-failures.jsonl`: a usage error, a
 * thrown action, a crash, a plain non-zero exit, an interrupt the tool handles itself (exit 130 or 143). A run the
 * default SIGINT or SIGTERM action ends never reaches the exit event, and a JS signal handler would make a
 * synchronous tool unkillable (interrupt.ts); the `tools` wrapper records that death when it waits for the tool
 * (launcher.ts). `runTool` calls it; an entry point without commander calls it itself. Once per process; only a
 * real CLI run, never a test that passes its own argv.
 */
export function watchToolRun({
    tool,
    argv = process.argv.slice(2),
    commandPath = () => null,
    secrets = () => ({ flags: [], indexes: [] }),
    caller = agentCaller,
    runId,
}: {
    tool: string;
    argv?: string[];
    commandPath?: () => string | null;
    secrets?: () => ArgvSecrets;
    caller?: () => FailureCaller | null;
    /** Defaults to the wrapper's id from the env (run-id.ts), which is then removed so child tools do not inherit it. */
    runId?: string;
}): void {
    if (run) {
        return;
    }

    run = {
        tool,
        argv,
        commandPath,
        secrets,
        caller,
        stderr: "",
        stdout: "",
        noted: null,
        ended: false,
        runId: runId ?? takeRunId(process.env),
    };
    tapStderr();
    process.on("uncaughtExceptionMonitor", (error) => {
        noteCrash(error, process.listenerCount("uncaughtException") === 0);
    });
    process.on("unhandledRejection", onRejection);
    process.once("exit", finish);
}
