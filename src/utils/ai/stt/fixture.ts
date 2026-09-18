import type { LiveSttSession, LiveTranscriptEvent, SttProviderId } from "./types";

export function createFixtureStt(options: {
    events: LiveTranscriptEvent[];
    accountId?: string;
    signal?: AbortSignal;
}): LiveSttSession {
    let closed = false;
    return {
        provider: "fixture" satisfies SttProviderId,
        accountId: options.accountId,
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
        },
    };
}
