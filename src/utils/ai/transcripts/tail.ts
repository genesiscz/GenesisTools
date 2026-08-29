import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { transcriptEnvelope } from "./load";
import { type ResolvedTranscript, rescanWorkerTurns } from "./resolve";
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

/** How often follow mode looks for a newer worker turn file. */
const WORKER_RESCAN_MS = 1000;

export async function followTranscript(resolved: ResolvedTranscript, opts: FollowTranscriptOptions): Promise<void> {
    let lastKey = "";
    let chain = Promise.resolve();
    let dirty = false;
    let running = false;
    let stopped = false;

    const emit = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        const envelope = await transcriptEnvelope(resolved, opts.slice);
        if (stopped) {
            return;
        }
        // A truncate-and-regrow rewrite can restore the same size, turn count and
        // offset, so those three cannot tell the new content from the old — the
        // envelope has to be fingerprinted as well or the reparse is suppressed
        // as a duplicate (round 4 t4; the "same-size in-place rewrite" wording
        // this comment used to carry was wrong, since FileWatcher is size-based
        // and never re-reads such a file at all — PR #341 review t11).
        //
        // SafeJSON rather than delimiter-joined fields (review t8): joining
        // arbitrary inputPreview/result values with an unescaped separator is not
        // injective, so moving a control character between two equal-length
        // fields produced an identical fingerprint for a genuinely different
        // envelope. JSON escapes them, so the encoding is unambiguous — and it
        // covers every turn field, tools included, without listing them here.
        const fingerprint = SafeJSON.stringify(envelope.turns);
        // The full fingerprint, not a hash of it (PR #341 review t2). Only ONE
        // previous key is retained, so keeping the whole string costs a single
        // envelope's worth of memory and removes the collision class that a
        // bounded hash would otherwise reintroduce — which is the exact property
        // the SafeJSON encoding above exists to provide.
        const key = `${envelope.byteSize}:${envelope.turns.length}:${envelope.nextOffset}:${fingerprint}`;
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
                while (dirty && !stopped) {
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

    let tailer = new FileTailer(resolved.filePath, {
        onLine: () => {
            schedule();
        },
    });
    tailer.start();

    // A worker session is a sequence of turn files and the next steer writes a
    // new one, which a tailer pinned to one path never sees (round 4, t2).
    const rescan = setInterval(() => {
        if (stopped) {
            return;
        }

        const next = rescanWorkerTurns(resolved);

        if (!next || next.filePath === resolved.filePath) {
            return;
        }

        logger.debug({ from: resolved.filePath, to: next.filePath }, "following a newer worker turn");
        resolved.filePath = next.filePath;
        resolved.extraFiles = next.extraFiles;
        tailer.stop();
        tailer = new FileTailer(resolved.filePath, {
            onLine: () => {
                schedule();
            },
        });
        tailer.start();
        schedule();
    }, WORKER_RESCAN_MS);

    await new Promise<void>((resolve) => {
        const stop = (): void => {
            stopped = true;
            clearInterval(rescan);
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
