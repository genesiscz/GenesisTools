import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { logger } from "@genesiscz/utils/logger";
import { type CompactSessionOptions, compactSession } from "./index";
import type { CompactResult } from "./schema";

const log = logger.child({ component: "ai:compact:stream" });

const DEFAULT_FOLLOW_SECONDS = 3600;
const FOLLOW_DEBOUNCE_MS = 250;

export interface FollowCompactOptions extends Omit<CompactSessionOptions, "text" | "filePath"> {
    filePath: string;
    /** Called once for the file as it stands, then again after every append that grew it. */
    onResult: (result: CompactResult, event: { pass: number; sourceBytes: number }) => void | Promise<void>;
    /** Hard wall-clock cap. A wait without a deadline is a bug, so this always has one. */
    maxSeconds?: number;
}

/**
 * Real `--follow`: compacts the file as it stands, then re-decides each time the transcript grows.
 *
 * Wakes on `fs.watch` with the shared slow poll behind it, because on bun 1.3.13 an `fs.watch`
 * created after the first watcher close in a process goes deaf. There is no sub-100 ms timer here.
 */
export async function followCompact(options: FollowCompactOptions): Promise<number> {
    const maxSeconds = options.maxSeconds ?? DEFAULT_FOLLOW_SECONDS;
    const deadlineAt = Date.now() + maxSeconds * 1000;
    let lastBytes = -1;
    let passes = 0;

    log.info({ filePath: options.filePath, maxSeconds }, "Following a transcript for streaming compaction");
    await watchFileFeed({
        path: options.filePath,
        deadlineAt,
        debounceMs: FOLLOW_DEBOUNCE_MS,
        signal: options.signal,
        onChange: async () => {
            const text = await Bun.file(options.filePath).text();
            const sourceBytes = Buffer.byteLength(text, "utf8");
            if (sourceBytes === lastBytes) {
                return;
            }

            lastBytes = sourceBytes;
            passes += 1;
            log.info({ pass: passes, sourceBytes }, "Transcript grew; recompacting");
            const result = await compactSession({ ...options, text, filePath: options.filePath });
            await options.onResult(result, { pass: passes, sourceBytes });
        },
    });

    log.info({ passes, filePath: options.filePath }, "Follow finished");
    return passes;
}
