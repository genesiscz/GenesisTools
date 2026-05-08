import { beforeEach, describe, expect, it } from "bun:test";
import { SseBroadcaster, sseBroadcaster } from "./sse-broadcaster";

beforeEach(() => sseBroadcaster.reset());

async function readNextEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const { value } = await reader.read();
    return new TextDecoder().decode(value ?? new Uint8Array());
}

describe("SseBroadcaster", () => {
    it("subscribe yields a hello frame immediately", async () => {
        const { stream } = sseBroadcaster.subscribe();
        const reader = stream.getReader();
        const first = await readNextEvent(reader);
        expect(first).toContain("event: hello");
        await reader.cancel();
    });

    it("publish fans out to all active subscribers", async () => {
        const a = sseBroadcaster.subscribe();
        const b = sseBroadcaster.subscribe();
        const ra = a.stream.getReader();
        const rb = b.stream.getReader();
        await ra.read();
        await rb.read();
        sseBroadcaster.publish("notification-fired", { id: 7 });
        const fa = await readNextEvent(ra);
        const fb = await readNextEvent(rb);
        expect(fa).toContain("event: notification-fired");
        expect(fa).toContain('"id":7');
        expect(fb).toContain("event: notification-fired");
        await ra.cancel();
        await rb.cancel();
    });

    it("subscriberCount tracks subscribe/unsubscribe", () => {
        expect(sseBroadcaster.subscriberCount()).toBe(0);
        const a = sseBroadcaster.subscribe();
        expect(sseBroadcaster.subscriberCount()).toBe(1);
        const b = sseBroadcaster.subscribe();
        expect(sseBroadcaster.subscriberCount()).toBe(2);
        a.unsubscribe();
        expect(sseBroadcaster.subscriberCount()).toBe(1);
        b.unsubscribe();
        expect(sseBroadcaster.subscriberCount()).toBe(0);
    });

    it("reset closes all subscribers and clears state", async () => {
        const { stream } = sseBroadcaster.subscribe();
        const reader = stream.getReader();
        await reader.read();
        sseBroadcaster.reset();
        expect(sseBroadcaster.subscriberCount()).toBe(0);
        const { done } = await reader.read();
        expect(done).toBe(true);
    });

    it("publish is a no-op when nobody is listening", () => {
        expect(() => sseBroadcaster.publish("notification-fired", { id: 1 })).not.toThrow();
    });

    it("a fresh SseBroadcaster instance is independent of the singleton", () => {
        const b = new SseBroadcaster();
        const a = sseBroadcaster.subscribe();
        expect(b.subscriberCount()).toBe(0);
        expect(sseBroadcaster.subscriberCount()).toBe(1);
        a.unsubscribe();
    });
});
