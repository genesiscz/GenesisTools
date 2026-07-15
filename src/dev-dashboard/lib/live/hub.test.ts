import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { createLiveHub } from "./hub";
import type { LiveFrame } from "./types";

function mockEmit() {
    const frames: LiveFrame[] = [];
    return {
        frames,
        emit: {
            data: (payload: string) => {
                frames.push(SafeJSON.parse(payload, { strict: true }) as LiveFrame);
            },
            comment: () => {},
        },
    };
}

describe("LiveHub", () => {
    test("open sends hello; publish fans out only to matching channels", () => {
        const hub = createLiveHub();
        const a = mockEmit();
        const b = mockEmit();
        const openA = hub.open(a.emit, ["ports"]);
        hub.open(b.emit, ["pulse"]);

        expect(a.frames[0]).toMatchObject({ type: "hello", channel: "system" });
        expect((a.frames[0] as { payload: { connId: string } }).payload.connId).toBe(openA.connId);

        hub.publish({
            v: 1,
            channel: "ports",
            type: "snapshot",
            payload: { lsofAvailable: true, ports: [], scannedAt: 1 },
        });

        expect(a.frames.some((f) => f.channel === "ports")).toBe(true);
        expect(b.frames.some((f) => f.channel === "ports")).toBe(false);
        expect(hub.subscriberCount("ports")).toBe(1);
        expect(hub.subscriberCount("pulse")).toBe(1);

        openA.close();
        expect(hub.subscriberCount("ports")).toBe(0);
        hub._reset();
    });

    test("setChannels moves demand and emits subscribed", () => {
        const hub = createLiveHub();
        const a = mockEmit();
        const { connId } = hub.open(a.emit, ["pulse"]);
        const next = hub.setChannels(connId, ["ports"]);
        expect(next).toEqual(["ports"]);
        expect(hub.subscriberCount("pulse")).toBe(0);
        expect(hub.subscriberCount("ports")).toBe(1);
        expect(a.frames.some((f) => f.type === "subscribed")).toBe(true);
        hub._reset();
    });

    test("onDemandChange fires on open and close", () => {
        const hub = createLiveHub();
        const events: Array<{ ch: string; d: number }> = [];
        hub.onDemandChange((ch, d) => events.push({ ch, d }));
        const a = mockEmit();
        const { close } = hub.open(a.emit, ["qa"]);
        expect(events).toEqual([{ ch: "qa", d: 1 }]);
        close();
        expect(events.at(-1)).toEqual({ ch: "qa", d: -1 });
        hub._reset();
    });
});
