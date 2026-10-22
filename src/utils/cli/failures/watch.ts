import { resolve } from "node:path";
import { format } from "node:util";
import { moduleDir, requireSibling } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { currentTraceId } from "@genesiscz/utils/trace";
import { redactSecretsInText } from "@genesiscz/utils/transclude/redact";
import { appendFailure, type FailureCaller, type FailureKind, type ToolFailure } from "./record";

const TAIL_CHARS = 4000;
const TOOLS_ROOT = resolve(moduleDir(import.meta), "../../../..");
const SECRET_FLAG = /^--?[\w-]*(?:token|secret|password|passwd|api[-_]?key|auth|cookie|credential)[\w-]*$/i;
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
    /** Who ran the tool, asked only when a failure is written (agent-caller.ts unless a test injects one). */
    caller: () => FailureCaller | null;
    stderr: string;
    /** Only read for a JSON error object; never stored, since stdout is the tool's result. */
    stdout: string;
    noted: Noted | null;
    ended: boolean;
}

let run: Run | null = null;

/** Masks the value of a secret-named flag (`--token x`, `--api-key=x`) and any secret-shaped argument. */
export function redactArgv(args: readonly string[]): string[] {
    return args.map((arg, index) => {
        const assigned = /^(--?[\w-]+)=/.exec(arg);
        if (assigned && SECRET_FLAG.test(assigned[1])) {
            return `${assigned[1]}=[redacted]`;
        }

        if (index > 0 && SECRET_FLAG.test(args[index - 1]) && !arg.startsWith("-")) {
            return "[redacted]";
        }

        return redactSecretsInText(arg);
    });
}

interface CommandNode {
    name(): string;
    aliases(): string[];
    readonly commands: readonly CommandNode[];
}

/** `ai usage sessions` for `tools ai usage sessions --bad`: the deepest subcommand the leading words name. */
export function commandPathFromArgv(program: CommandNode, args: readonly string[]): string {
    const names = [program.name()];
    let current = program;

    for (const word of args) {
        if (word.startsWith("-")) {
            break;
        }

        const next = current.commands.find((command) => command.name() === word || command.aliases().includes(word));
        if (!next) {
            break;
        }

        names.push(next.name());
        current = next;
    }

    return names.join(" ");
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
function agentCaller(): FailureCaller | null {
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
        const tail = redactSecretsInText(stripAnsi(run.stderr)).trim();
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
            argv: redactArgv(run.argv),
            exitCode,
            message: message ? redactSecretsInText(stripAnsi(message)).slice(0, 2000) : null,
            errorName: err?.name ?? null,
            stack: err?.stack ? redactSecretsInText(err.stack).slice(0, 8000) : null,
            stderrTail: tail || null,
            fatal,
            durationMs: Math.round(performance.now()),
            pid: process.pid,
            ppid: process.ppid,
            cwd: process.cwd(),
            traceId: currentTraceId() ?? null,
            toolsRoot: TOOLS_ROOT,
            caller: caller(),
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
    const exitCode = code || (typeof process.exitCode === "number" ? process.exitCode : 0);
    const kind = classifyExit({ exitCode, noted: run.noted, stderrTail: stripAnsi(run.stderr) });
    if (kind) {
        write(kind, exitCode, true);
    }
}

/** A crash some other listener handles: the process goes on, so it is written now, not at exit. */
function noteCrash(error: unknown, fatal: boolean): void {
    if (!run) {
        return;
    }

    run.noted = { kind: "crash", error, fatal };
    if (!fatal) {
        write("crash", null, false);
        run.noted = null;
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
 * thrown action, a crash, a plain non-zero exit, an interrupt. `runTool` calls it; an entry point without commander
 * calls it itself. Once per process; only a real CLI run, never a test that passes its own argv.
 */
export function watchToolRun({
    tool,
    argv = process.argv.slice(2),
    commandPath = () => null,
    caller = agentCaller,
}: {
    tool: string;
    argv?: string[];
    commandPath?: () => string | null;
    caller?: () => FailureCaller | null;
}): void {
    if (run) {
        return;
    }

    run = { tool, argv, commandPath, caller, stderr: "", stdout: "", noted: null, ended: false };
    tapStderr();
    process.on("uncaughtExceptionMonitor", (error) => {
        noteCrash(error, process.listenerCount("uncaughtException") === 0);
    });
    process.on("unhandledRejection", onRejection);
    process.once("exit", finish);
}
