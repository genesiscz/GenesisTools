import { logger } from "@genesiscz/utils/logger";
import { wrapWithGenesisApp } from "@genesiscz/utils/macos/genesis-app";
import { signalProcessTree } from "@genesiscz/utils/process/processes";

const { log } = logger.scoped("screen-recorder");

/** After SIGINT a recorder writes its last frame and its result; past this its tree is killed. */
const STOP_GRACE_MS = 10_000;
/** A pipe still held by a killed grandchild must not hold the result. */
const PIPE_DRAIN_MS = 2_000;

export interface CaptureProcessResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
}

/** Reads a pipe to its end, handing each complete line to `onLine` as it arrives. */
async function readLines(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    let pending = "";

    for await (const chunk of stream) {
        const piece = decoder.decode(chunk, { stream: true });
        text += piece;

        if (!onLine) {
            continue;
        }

        pending += piece;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";

        for (const line of lines) {
            if (line.trim()) {
                onLine(line);
            }
        }
    }

    if (onLine && pending.trim()) {
        onLine(pending);
    }

    return text;
}

/** The text of a pipe that is being read already, or "" when it is still open PIPE_DRAIN_MS after the exit. */
async function drained(text: Promise<string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), PIPE_DRAIN_MS);
    });
    const result = await Promise.race([text, late]);
    clearTimeout(timer);
    return result;
}

/**
 * Runs one capture through the GenesisTools.app launcher, so macOS attributes the Screen Recording grant to the app.
 * `signal` stops it with SIGINT (the recorder then prints what it kept); past `timeoutMs` it is stopped the same way and
 * `timedOut` is set. A recorder that ignores SIGINT is killed with its tree after a grace period.
 */
export async function runCaptureProcess(options: {
    argv: string[];
    timeoutMs: number;
    signal?: AbortSignal;
    /** Default: the GenesisTools.app launcher. */
    launch?: (argv: string[]) => string[];
    /** Each stderr line as it comes (the recorder's events); stderr is still returned whole. */
    onStderrLine?: (line: string) => void;
    /** Keeps stdin open and hands over a writer for it; stdin closes when the process ends. */
    onStdin?: (write: (text: string) => void) => void;
}): Promise<CaptureProcessResult> {
    const launch = options.launch ?? wrapWithGenesisApp;
    const proc = Bun.spawn(launch(options.argv), {
        stdin: options.onStdin ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = readLines(proc.stderr, options.onStderrLine);

    if (options.onStdin && proc.stdin) {
        const sink = proc.stdin;
        options.onStdin((text) => {
            if (proc.exitCode === null) {
                sink.write(text);
                void sink.flush();
            }
        });
    }

    let timedOut = false;
    let aborted = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        if (proc.exitCode !== null || grace) {
            return;
        }

        proc.kill("SIGINT");
        grace = setTimeout(() => {
            if (proc.exitCode === null) {
                log.warn({ pid: proc.pid }, "recorder ignored SIGINT; killing its process tree");
                signalProcessTree(proc.pid, { signal: "SIGKILL", includeSelf: true });
            }
        }, STOP_GRACE_MS);
    };
    const onAbort = () => {
        aborted = true;
        stop();
    };
    const deadline = setTimeout(() => {
        timedOut = true;
        log.warn({ argv: options.argv, timeoutMs: options.timeoutMs }, "capture hung past its deadline");
        stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.signal?.aborted) {
        onAbort();
    }

    try {
        const exitCode = await proc.exited;

        if (options.onStdin && proc.stdin) {
            await Promise.resolve(proc.stdin.end()).catch((error: unknown) =>
                log.debug({ error }, "stdin already closed")
            );
        }

        const [out, err] = await Promise.all([drained(stdout), drained(stderr)]);
        return { exitCode, stdout: out, stderr: err, timedOut, aborted };
    } finally {
        clearTimeout(deadline);
        clearTimeout(grace);
        options.signal?.removeEventListener("abort", onAbort);
    }
}
