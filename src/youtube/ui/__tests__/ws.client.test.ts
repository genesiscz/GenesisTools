import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { createEventStream } from "@app/yt/ws.client";

interface WebSocketConstructor {
    new (url: string): FakeWebSocket;
    instances: FakeWebSocket[];
}

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((message: MessageEvent<string>) => void) | null = null;
    sent: string[] = [];

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    send(message: string) {
        this.sent.push(message);
    }

    close() {
        this.onclose?.();
    }
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

function resetHooks() {}

describe("useEventStream", () => {
    beforeEach(() => {
        FakeWebSocket.instances.length = 0;
        globalThis.fetch = (async () =>
            Response.json({
                config: { apiBaseUrl: "http://api.example.test" },
                where: "/tmp/server.json",
            })) as unknown as typeof fetch;
        globalThis.WebSocket = FakeWebSocket as unknown as WebSocketConstructor & typeof WebSocket;
        resetHooks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.WebSocket = originalWebSocket;
    });

    it("subscribes to configured websocket events and forwards messages", async () => {
        const events: unknown[] = [];

        const stream = await createEventStream({ jobIds: [1, 2], onEvent: (event) => events.push(event) });

        const socket = FakeWebSocket.instances[0];
        expect(socket?.url).toBe("ws://api.example.test/api/v1/events");
        expect(stream.connected).toBe(false);

        socket?.onopen?.();
        expect(socket?.sent[0]).toBe(SafeJSON.stringify({ type: "subscribe", jobIds: [1, 2] }));

        socket?.onmessage?.({ data: SafeJSON.stringify({ type: "job:cancelled", jobId: 1 }) } as MessageEvent<string>);
        expect(events).toEqual([{ type: "job:cancelled", jobId: 1 }]);
    });
});
