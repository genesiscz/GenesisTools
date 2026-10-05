import { existsSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { ESLOGGER_PATH } from "./events";
import type { EventStream } from "./stream";

/** sudo prints this on the terminal; `%u` is the invoking user. */
export const SUDO_PROMPT = "[sudo] password for %u (eslogger needs root): ";

export interface EsloggerInvocation {
    argv: string[];
    viaSudo: boolean;
}

/**
 * eslogger must run as root. When this process is not root, only eslogger is raised through sudo, so
 * the tool itself (and the files it writes under ~/.genesis-tools) never runs as root.
 */
export function esloggerInvocation(options: { events: readonly string[]; isRoot: boolean }): EsloggerInvocation {
    const argv = [ESLOGGER_PATH, ...options.events];

    if (options.isRoot) {
        return { argv, viaSudo: false };
    }

    return { argv: ["sudo", "-p", SUDO_PROMPT, ...argv], viaSudo: true };
}

export type StderrKind = "not-privileged" | "not-permitted" | "not-entitled" | "bad-event" | "sudo" | "other";

/**
 * Sort one eslogger or sudo stderr line. The ES_NEW_CLIENT_RESULT_* names and the "Failed to parse
 * event types" prefix are the strings in /usr/bin/eslogger on macOS 26.3, the same names the
 * EndpointSecurity headers use for `es_new_client` results.
 */
export function classifyStderr(line: string): StderrKind {
    if (line.includes("ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED")) {
        return "not-privileged";
    }

    if (line.includes("ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED")) {
        return "not-permitted";
    }

    if (line.includes("ES_NEW_CLIENT_RESULT_ERR_NOT_ENTITLED")) {
        return "not-entitled";
    }

    if (line.includes("Failed to parse event types")) {
        return "bad-event";
    }

    if (line.startsWith("sudo:") || line.includes("incorrect password") || line.startsWith("Sorry, try again")) {
        return "sudo";
    }

    return "other";
}

const FDA_PANE = `${toolCommand("macos permissions open")} --pane full-disk-access`;

/** The Full Disk Access fix. `subject` names who must hold the grant (GenesisTools.app or the terminal). */
export function fullDiskAccessMessage(subject: string): string {
    return [
        `eslogger also needs Full Disk Access for ${subject}, the app macOS holds responsible for this command.`,
        "Add it in System Settings > Privacy & Security > Full Disk Access and switch it on, then run the command again.",
        `Open that pane: ${FDA_PANE}`,
    ].join("\n");
}

/** Printed instead of starting sudo when it could not ask for a password. */
export function rootRequiredMessage(options: { command: string; fdaSubject: string }): string {
    return [
        "eslogger must run as root, and sudo cannot ask for your password because this command has no terminal.",
        "Fix: run the same command in a terminal. sudo asks for your password there, and only eslogger runs as root:",
        `  ${options.command}`,
        "",
        fullDiskAccessMessage(options.fdaSubject),
    ].join("\n");
}

/** What to tell the user for a classified stderr line; undefined passes the line through as it is. */
export function explainStderr(kind: StderrKind, fdaSubject: string): string | undefined {
    switch (kind) {
        case "not-permitted":
            return `eslogger refused to start: Full Disk Access is missing.\n${fullDiskAccessMessage(fdaSubject)}`;
        case "not-privileged":
            return "eslogger refused to start: it did not run as root. Run the command in a terminal so sudo can raise it.";
        case "not-entitled":
            return "eslogger refused to start: it lacks the Endpoint Security entitlement. /usr/bin/eslogger is not the system copy, or System Integrity Protection is off.";
        default:
            return undefined;
    }
}

/** The subset of Bun's Subprocess this module drives, so a test can hand in a fake. */
export interface CaptureProcess {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    kill(signal?: NodeJS.Signals): void;
    /** Lets this process exit while the child still runs. Bun's Subprocess has it. */
    unref?(): void;
}

export type CaptureSpawner = (argv: string[]) => CaptureProcess;

export const spawnCapture: CaptureSpawner = (argv) =>
    Bun.spawn(argv, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });

export interface LiveCaptureOptions {
    invocation: EsloggerInvocation;
    stream: EventStream;
    /** Aborts on Ctrl-C (`withInterrupt`). */
    signal: AbortSignal;
    onStderrLine: (line: string) => void;
    spawn?: CaptureSpawner;
    /** After Ctrl-C, how long eslogger gets to exit before SIGTERM. */
    stopTimeoutMs?: number;
}

export interface CaptureResult {
    exitCode: number | null;
    signalCode: string | null;
    interrupted: boolean;
}

async function pump(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
    halt?: AbortSignal
): Promise<void> {
    const reader = stream.getReader();
    const cancel = () => {
        reader.cancel().catch((error) => logger.debug({ error }, "eslogger: cancelling a stream failed"));
    };
    halt?.addEventListener("abort", cancel, { once: true });

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            halt?.removeEventListener("abort", cancel);
            return;
        }

        onChunk(value);
    }
}

function lineSplitter(onLine: (line: string) => void): { write: (chunk: Uint8Array) => void; end: () => void } {
    const decoder = new TextDecoder();
    let buffer = "";

    const emit = (line: string) => {
        const trimmed = line.trim();

        if (trimmed.length > 0) {
            onLine(trimmed);
        }
    };

    return {
        write: (chunk) => {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            lines.forEach(emit);
        },
        end: () => {
            emit(buffer + decoder.decode());
            buffer = "";
        },
    };
}

/**
 * Start eslogger, feed its stdout through the stream and its stderr to `onStderrLine`, and stop it on
 * Ctrl-C: SIGINT first (sudo relays it), SIGTERM if it has not exited after `stopTimeoutMs`, and after
 * another `stopTimeoutMs` stop waiting and throw. SIGKILL is never sent: sudo cannot relay it, and
 * killing sudo would leave eslogger running as root.
 */
export async function runLiveCapture(options: LiveCaptureOptions): Promise<CaptureResult> {
    const spawn = options.spawn ?? spawnCapture;
    const stopTimeoutMs = options.stopTimeoutMs ?? 3000;
    logger.debug({ argv: options.invocation.argv, viaSudo: options.invocation.viaSudo }, "eslogger: spawning");
    const child = spawn(options.invocation.argv);
    const halt = new AbortController();
    const gaveUp = Promise.withResolvers<void>();
    let interrupted = false;
    let stopping = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;

    const running = () => child.exitCode === null && child.signalCode === null;

    const stop = () => {
        interrupted = true;

        if (stopping || !running()) {
            return;
        }

        stopping = true;
        logger.debug("eslogger: Ctrl-C, sending SIGINT");
        child.kill("SIGINT");
        stopTimer = setTimeout(() => {
            if (!running()) {
                return;
            }

            logger.warn({ stopTimeoutMs }, "eslogger: still running after SIGINT, sending SIGTERM");
            child.kill("SIGTERM");
            giveUpTimer = setTimeout(() => {
                if (!running()) {
                    return;
                }

                logger.warn({ stopTimeoutMs }, "eslogger: still running after SIGTERM, no longer waiting for it");
                child.unref?.();
                gaveUp.resolve();
            }, stopTimeoutMs);
        }, stopTimeoutMs);
    };

    if (options.signal.aborted) {
        stop();
    } else {
        options.signal.addEventListener("abort", stop, { once: true });
    }

    const stderrLines = lineSplitter(options.onStderrLine);

    let exited = false;

    try {
        exited = await Promise.race([
            Promise.all([
                pump(child.stdout, (chunk) => options.stream.write(chunk), halt.signal),
                pump(child.stderr, stderrLines.write, halt.signal),
                child.exited,
            ]).then(() => true),
            gaveUp.promise.then(() => false),
        ]);
    } catch (error) {
        logger.warn({ error }, "eslogger: a stream failed, stopping eslogger");
        stop();
        await Promise.race([child.exited, gaveUp.promise]);
        halt.abort();
        throw error;
    } finally {
        options.signal.removeEventListener("abort", stop);
        clearTimeout(stopTimer);
        clearTimeout(giveUpTimer);
    }

    if (!exited) {
        halt.abort();
        options.stream.end();
        stderrLines.end();
        const pkill = `${options.invocation.viaSudo ? "sudo " : ""}pkill eslogger`;
        throw new Error(
            `eslogger did not exit after SIGINT and SIGTERM, so it may still be running. Stop it with: ${pkill}`
        );
    }

    options.stream.end();
    stderrLines.end();
    const result = { exitCode: child.exitCode, signalCode: child.signalCode, interrupted };
    logger.debug({ ...result, stats: options.stream.stats }, "eslogger: stopped");
    return result;
}

/** `eslogger --list-events` stdout, or null when eslogger is missing or fails. Needs no root. */
export function listEventsFromEslogger(): string | null {
    if (!existsSync(ESLOGGER_PATH)) {
        logger.debug({ path: ESLOGGER_PATH }, "eslogger: not installed, using the built-in event list");
        return null;
    }

    const result = Bun.spawnSync([ESLOGGER_PATH, "--list-events"], { stdout: "pipe", stderr: "pipe", timeout: 5000 });

    if (result.exitCode !== 0) {
        logger.debug(
            { exitCode: result.exitCode, stderr: result.stderr.toString() },
            "eslogger: --list-events failed, using the built-in event list"
        );
        return null;
    }

    return result.stdout.toString();
}

/** Replay recorded eslogger output (a file, or `-` for stdin) through the stream. Needs no root. */
export async function replayInput(input: string, stream: EventStream): Promise<void> {
    const source = input === "-" ? Bun.stdin.stream() : Bun.file(input).stream();
    logger.debug({ input }, "eslogger: replaying recorded events");
    await pump(source, (chunk) => stream.write(chunk));
    stream.end();
}
