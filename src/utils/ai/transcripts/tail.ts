import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
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
/** FNV-1a, enough to notice that a same-size rewrite changed the content. */
function simpleHash(value: string): string {
    let hash = 2166136261;

    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36);
}

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
        // Size, count and offset are all unchanged by an in-place head rewrite,
        // which FileTailer detects on purpose — so fingerprint the content too,
        // or the tailer's rewrite support is discarded here (round 4, t4).
        //
        // Every emitted field participates, tools included. Fingerprinting only
        // role/at/text meant a same-size rewrite that changed nothing but a tool
        // result or its error flag produced an identical key and was dropped as
        // a duplicate — the same stale-envelope bug one level down (t7).
        const fingerprint = envelope.turns
            .map((t) => {
                const tools = t.tools
                    .map(
                        (tool) =>
                            `${tool.id}\u0003${tool.name}\u0003${tool.inputPreview}\u0003${tool.result ?? ""}\u0003${tool.isError}`
                    )
                    .join("\u0004");

                return `${t.role}\u0001${t.at ?? ""}\u0001${t.text}\u0001${tools}`;
            })
            .join("\u0002");
        const key = `${envelope.byteSize}:${envelope.turns.length}:${envelope.nextOffset}:${fingerprint.length}:${simpleHash(fingerprint)}`;
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
