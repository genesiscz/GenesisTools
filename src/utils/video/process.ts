import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { CHILD_EXEC_FAILED_EXIT, childDeadlineTermination } from "@genesiscz/utils/process/child-deadline";
import { profiler } from "@genesiscz/utils/profile";

/**
 * The process started, ran and exited with a non-zero code: it judged its input. A process that could not start,
 * timed out, was cancelled or was killed by a signal throws a plain Error instead (also when the child-deadline
 * watchdog reports one of those as its own exit status).
 */
export class VideoCommandExitError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = "VideoCommandExitError";
    }
}

/**
 * The text with every URL's query replaced: a media URL's query often carries a signed token (Twitch's `sig` and
 * `token`), and ffmpeg repeats its input URL in its errors. Logs, thrown messages and saved errors show this form.
 */
export function redactUrlQueries(text: string): string {
    return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']+)\?[^\s#"']*/gi, "$1?[redacted]");
}

/** Why the child-deadline watchdog ended the run without the program judging its input, or null for a real exit. */
function watchdogReason({ program, status }: { program: string; status: number | null }): string | null {
    if (status === CHILD_EXEC_FAILED_EXIT) {
        return `${program} could not start (not installed or not executable)`;
    }

    const cutShort = childDeadlineTermination(status);
    return cutShort ? `${program} stopped: ${cutShort}` : null;
}

/**
 * Runs ffmpeg or ffprobe and returns its stdout. With `onStdout`, each stdout chunk goes to it as it comes, nothing is
 * buffered, and the returned text is only the last 16 KB.
 */
export async function runVideoCommand({
    command,
    signal,
    timeoutMs = 120_000,
    onStdout,
}: {
    command: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    onStdout?: (chunk: Uint8Array) => void;
}): Promise<string> {
    logger.debug(
        { command: command.map(redactUrlQueries), timeoutMs, streamed: Boolean(onStdout) },
        "Video process started"
    );
    const result = await profiler.scope("video").measureAsync(command[0], () =>
        boundedCommand({
            command,
            signal,
            timeoutMs,
            maxBufferBytes: 32 * 1024 * 1024,
            ...(onStdout ? { streamOnly: true, onStdout } : {}),
        })
    );
    signal?.throwIfAborted();
    if (result.error || result.status !== 0) {
        const stderr = redactUrlQueries(result.stderr);
        logger.warn(
            { error: result.error, status: result.status, stderr: stderr.slice(-4000) },
            "Video process failed"
        );
        const notRun = result.error ? null : watchdogReason({ program: command[0], status: result.status });
        const raw = result.error?.message ?? (stderr.slice(-2000) || notRun || "Video process failed");
        const message = redactUrlQueries(raw);

        if (!result.error && result.status !== null && !notRun) {
            throw new VideoCommandExitError(message, result.status);
        }

        throw new Error(message);
    }

    return result.stdout;
}
