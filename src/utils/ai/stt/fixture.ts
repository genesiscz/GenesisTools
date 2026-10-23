import { abortableSleep } from "@genesiscz/utils/async";
import type { LiveSttSession, LiveTranscriptEvent, SttProviderId } from "./types";

/**
 * Replays supplied events; accepts and discards audio so callers need no special case. With `followsAudio` it
 * answers like a live provider: an event comes at its `startedAtMs` after the session opened, and the replay ends
 * after `end()` (the audio ran out or the user stopped), so a test sees partial text while audio still flows.
 */
export function createFixtureStt(options: {
    events: LiveTranscriptEvent[];
    accountId?: string;
    signal?: AbortSignal;
    followsAudio?: boolean;
}): LiveSttSession {
    let closed = false;
    let audioBytes = 0;
    const opened = Date.now();
    let markEnded = () => {};
    const ended = new Promise<void>((resolve) => {
        markEnded = resolve;
    });
    return {
        provider: "fixture" satisfies SttProviderId,
        accountId: options.accountId,
        write(pcm) {
            audioBytes += pcm.byteLength;
        },
        end() {
            // Nothing pending: the fixture never buffers.
            markEnded();
        },
        async *events() {
            for (const event of options.events) {
                options.signal?.throwIfAborted();
                if (closed) {
                    return;
                }

                if (options.followsAudio) {
                    const wait = event.startedAtMs - (Date.now() - opened);
                    if (wait > 0) {
                        await abortableSleep(wait, options.signal);
                    }
                }

                yield event;
            }

            if (options.followsAudio && !closed) {
                await ended;
            }
        },
        async close() {
            closed = true;
            markEnded();
            void audioBytes;
        },
    };
}
