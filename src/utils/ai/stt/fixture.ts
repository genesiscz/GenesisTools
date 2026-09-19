import type { LiveSttSession, LiveTranscriptEvent, SttProviderId } from "./types";

/** Replays supplied events; accepts and discards audio so callers need no special case. */
export function createFixtureStt(options: {
    events: LiveTranscriptEvent[];
    accountId?: string;
    signal?: AbortSignal;
}): LiveSttSession {
    let closed = false;
    let audioBytes = 0;
    return {
        provider: "fixture" satisfies SttProviderId,
        accountId: options.accountId,
        write(pcm) {
            audioBytes += pcm.byteLength;
        },
        end() {
            // Nothing pending: the fixture never buffers.
        },
        async *events() {
            for (const event of options.events) {
                options.signal?.throwIfAborted();
                if (closed) {
                    return;
                }

                yield event;
            }
        },
        async close() {
            closed = true;
            void audioBytes;
        },
    };
}
