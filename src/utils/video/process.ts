import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { profiler } from "@genesiscz/utils/profile";

export async function runVideoCommand({
    command,
    signal,
    timeoutMs = 120_000,
}: {
    command: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<string> {
    logger.info({ command, timeoutMs }, "Video process started");
    const result = await profiler
        .scope("video")
        .measureAsync(command[0], () =>
            boundedCommand({ command, signal, timeoutMs, maxBufferBytes: 32 * 1024 * 1024 })
        );
    signal?.throwIfAborted();
    if (result.error || result.status !== 0) {
        logger.warn(
            { error: result.error, status: result.status, stderr: result.stderr.slice(-4000) },
            "Video process failed"
        );
        throw new Error(result.error?.message ?? (result.stderr.slice(-2000) || "Video process failed"));
    }

    return result.stdout;
}
