import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { createLiveHub } from "./hub";
import { type LiveProducer, type LiveProducerTable, startLiveProducers } from "./producers";
import type { LiveChannel, LiveDataFrame, LiveFrame } from "./types";

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

    test("publish serializes one shared payload for all matching subscribers and none without demand", () => {
        let serializations = 0;
        const hub = createLiveHub({
            serialize(frame) {
                serializations += 1;
                return SafeJSON.stringify(frame);
            },
        });
        const frame: LiveFrame = {
            v: 1,
            channel: "ports",
            type: "snapshot",
            payload: { lsofAvailable: true, ports: [], scannedAt: 1 },
        };

        hub.publish(frame);
        expect(serializations).toBe(0);

        const clients = Array.from({ length: 8 }, () => mockEmit());
        for (const client of clients) {
            hub.open(client.emit, ["ports"]);
        }

        // Hello frames are connection-specific; measure only the broadcast below.
        serializations = 0;
        hub.publish(frame);
        expect(serializations).toBe(1);
        expect(clients.every((client) => client.frames.some((candidate) => candidate.channel === "ports"))).toBe(true);
    });
});

const PORTS_SNAPSHOT: LiveDataFrame = {
    v: 1,
    channel: "ports",
    type: "snapshot",
    payload: { lsofAvailable: true, ports: [], scannedAt: 7 },
};

/** A producer per channel that records its starts and stops; `ports` answers joiners with a snapshot. */
function fakeTable() {
    const log: string[] = [];
    const make = (channel: LiveChannel, snapshot?: () => Promise<LiveDataFrame[]>) => (): LiveProducer => ({
        start: () => log.push(`start ${channel}`),
        stop: () => log.push(`stop ${channel}`),
        ...(snapshot ? { snapshot } : {}),
    });
    const table: LiveProducerTable = {
        ports: make("ports", async () => [PORTS_SNAPSHOT]),
        pulse: make("pulse"),
        "ai-usage": make("ai-usage"),
        qa: make("qa"),
        decisions: make("decisions"),
        pending: make("pending"),
        handoffs: make("handoffs"),
    };

    return { log, table };
}

describe("live producers", () => {
    test("a producer starts on the first subscriber and stops on the last", () => {
        const hub = createLiveHub();
        const { log, table } = fakeTable();
        const runner = startLiveProducers(hub, table);

        const a = hub.open(mockEmit().emit, ["qa"]);
        const b = hub.open(mockEmit().emit, ["qa", "decisions"]);
        expect(log).toEqual(["start qa", "start decisions"]);

        a.close();
        expect(log).toEqual(["start qa", "start decisions"]);

        hub.setChannels(b.connId, ["decisions"]);
        expect(log.at(-1)).toBe("stop qa");

        b.close();
        expect(log.at(-1)).toBe("stop decisions");
        expect(hub.subscriberCount("decisions")).toBe(0);

        runner.stop();
        hub._reset();
    });

    test("a connection that joins a running producer gets the snapshot, and only that connection", async () => {
        const hub = createLiveHub();
        const { log, table } = fakeTable();
        startLiveProducers(hub, table);

        const first = mockEmit();
        hub.open(first.emit, ["ports"]);
        const second = mockEmit();
        const { connId } = hub.open(second.emit, ["ports"]);
        await Bun.sleep(0);

        expect(log).toEqual(["start ports"]);
        expect(second.frames[0]).toMatchObject({ channel: "system", type: "hello", payload: { connId } });
        expect(second.frames[1]).toEqual(PORTS_SNAPSHOT);
        expect(first.frames.filter((f) => f.channel === "ports")).toEqual([]);
        hub._reset();
    });

    test("a snapshot is not sent to a connection that dropped the channel before it resolved", async () => {
        const hub = createLiveHub();
        const { table } = fakeTable();
        startLiveProducers(hub, table);

        hub.open(mockEmit().emit, ["ports"]);
        const late = mockEmit();
        const { connId } = hub.open(late.emit, ["ports"]);
        hub.setChannels(connId, ["pulse"]);
        await Bun.sleep(0);

        expect(late.frames.filter((f) => f.channel === "ports")).toEqual([]);
        hub._reset();
    });
});
