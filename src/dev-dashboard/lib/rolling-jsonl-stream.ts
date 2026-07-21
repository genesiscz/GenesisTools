import { existsSync, readFileSync } from "node:fs";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { parseJsonlChunk } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "dev-dashboard:rolling-jsonl" });

const ROLLOVER_CHECK_MS = 5_000;

export interface RollingJsonlStream {
    close(): void;
}

/**
 * Midnight-safe JSONL tailer: periodic re-check of `fileForNow()`, swap the
 * FileTailer on path change, and replay the new file from byte 0 so events
 * written before attach are not missed (handoff-sse §8.10 mechanism).
 */
export function createRollingJsonlStream<T>({
    fileForNow,
    onLine,
    checkIntervalMs = ROLLOVER_CHECK_MS,
}: {
    fileForNow: () => string;
    onLine: (value: T) => void;
    checkIntervalMs?: number;
}): RollingJsonlStream {
    let file = fileForNow();
    let tailer = new FileTailer<T>(file, { onLine });
    tailer.start();

    const replayFromStart = (path: string): void => {
        if (!existsSync(path)) {
            return;
        }

        try {
            const { values } = parseJsonlChunk<T>(readFileSync(path));

            for (const value of values) {
                onLine(value);
            }
        } catch (err) {
            log.warn({ err, path }, "rollover replay failed (new day file unparseable)");
        }
    };

    const rollover = setInterval(() => {
        const current = fileForNow();

        if (current !== file) {
            tailer.stop();
            file = current;
            tailer = new FileTailer<T>(file, { onLine });
            tailer.start();
            replayFromStart(file);
        }
    }, checkIntervalMs);

    return {
        close: () => {
            clearInterval(rollover);
            tailer.stop();
        },
    };
}
