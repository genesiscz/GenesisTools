import type { ConnectOptions, LiveSttProvider, LiveSttSession, TranscriptEvent } from "./types";

export class MockLiveStt implements LiveSttProvider {
    readonly id = "mock" as const;
    constructor(private readonly injected: TranscriptEvent[] = []) {}

    async connect(_options: ConnectOptions): Promise<LiveSttSession> {
        const queue = [...this.injected];
        let closed = false;
        return {
            write() {},
            async *events() {
                for (const event of queue) {
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
}
