import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { logger } from "@genesiscz/utils/logger";
import { transcriptEnvelope } from "./load";
import type { ResolvedTranscript } from "./resolve";
import type { SliceOptions, TranscriptEnvelope } from "./types";

export interface FollowTranscriptOptions {
    onEnvelope: (envelope: TranscriptEnvelope) => void | Promise<void>;
    slice?: SliceOptions;
    signal?: AbortSignal;
}

/**
 * Dump the current envelope, then re-parse with parseJsonl whenever FileTailer
 * emits a complete JSON object. Re-parse (not incremental records) so tool_call
 * / tool_result pairing stays correct across Claude, Grok ACP, and Codex.
 */
export async function followTranscript(resolved: ResolvedTranscript, opts: FollowTranscriptOptions): Promise<void> {
    let lastKey = "";
    let chain = Promise.resolve();
    let dirty = false;
    let running = false;
    let stopped = false;

    const emit = async (): Promise<void> => {
        const envelope = await transcriptEnvelope(resolved, opts.slice);
        const key = `${envelope.byteSize}:${envelope.turns.length}:${envelope.nextOffset}`;
        if (key === lastKey) {
            return;
        }
        lastKey = key;
        await opts.onEnvelope(envelope);
    };

    const schedule = (): void => {
        if (stopped) {
            return;
        }
        dirty = true;
        if (running) {
            return;
        }
        running = true;
        chain = chain
            .then(async () => {
                while (dirty) {
                    dirty = false;
                    await emit();
                }
            })
            .catch((error: unknown) => {
                logger.debug({ error, path: resolved.filePath }, "transcript reparse failed");
            })
            .finally(() => {
                running = false;
                if (dirty) {
                    schedule();
                }
            });
    };

    await emit();

    const tailer = new FileTailer(resolved.filePath, {
        onLine: () => {
            schedule();
        },
    });
    tailer.start();

    await new Promise<void>((resolve) => {
        const stop = (): void => {
            stopped = true;
            tailer.stop();
            resolve();
        };
        if (opts.signal?.aborted) {
            stop();
            return;
        }
        opts.signal?.addEventListener("abort", stop, { once: true });
    });
}
