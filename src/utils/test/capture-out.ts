import { stripAnsi } from "@genesiscz/utils/string";

export interface CapturedOutput {
    stdout: string;
    stderr: string;
}

type WriteCallback = (error?: Error | null) => void;

/**
 * Swap `process.stdout.write` and `process.stderr.write` for collectors, and give the real ones back in
 * `finally`. `out.println`, `out.print`, `out.log.*` and `ui.raw` all end in these two writes, so a test can read
 * what a command printed without spawning it. The write callback is called, or `writeStdout` would never settle.
 */
function swapStreams(sinks: CapturedOutput): () => void {
    const realStdout = process.stdout.write.bind(process.stdout);
    const realStderr = process.stderr.write.bind(process.stderr);
    const collector =
        (key: keyof CapturedOutput) =>
        (
            chunk: string | Uint8Array,
            encodingOrCallback?: BufferEncoding | WriteCallback,
            maybeCallback?: WriteCallback
        ): boolean => {
            sinks[key] += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            // Both forms of Writable.write: (chunk, callback) and (chunk, encoding, callback).
            const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;

            if (typeof callback === "function") {
                callback(null);
            }

            return true;
        };

    process.stdout.write = collector("stdout") as typeof process.stdout.write;
    process.stderr.write = collector("stderr") as typeof process.stderr.write;

    return () => {
        process.stdout.write = realStdout;
        process.stderr.write = realStderr;
    };
}

/** What `run` printed to stdout, without colour codes. Synchronous: `out.println` writes before it returns. */
export function captureOut(run: () => void): string {
    const sinks: CapturedOutput = { stdout: "", stderr: "" };
    const restore = swapStreams(sinks);

    try {
        run();
    } finally {
        restore();
    }

    return stripAnsi(sinks.stdout);
}

/** What `run` printed to stdout and to stderr, without colour codes. */
export async function captureOutput(run: () => void | Promise<void>): Promise<CapturedOutput> {
    const sinks: CapturedOutput = { stdout: "", stderr: "" };
    const restore = swapStreams(sinks);

    try {
        await run();
    } finally {
        restore();
    }

    return { stdout: stripAnsi(sinks.stdout), stderr: stripAnsi(sinks.stderr) };
}
