import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBoardPhaseRow } from "@app/dev-dashboard/contract/agents";
import { SafeJSON } from "@genesiscz/utils/json";
import { createLiveHub } from "./hub";
import {
    createAgentsProducer,
    createDecisionsProducer,
    type LiveProducer,
    type LiveProducerTable,
    startLiveProducers,
} from "./producers";
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
        agents: make("agents"),
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

function phaseRow(key: string, extra: Partial<AgentBoardPhaseRow> = {}): AgentBoardPhaseRow {
    return {
        key,
        provider: "claude",
        sessionId: key.split(":")[1] ?? null,
        phase: "thinking",
        label: "thinking",
        stalled: false,
        stuck: null,
        pid: 4100,
        lastActivityAt: 1,
        ...extra,
    };
}

describe("agents producer", () => {
    test("snapshot first, a phase frame per changed session, a snapshot again when a session starts or ends", async () => {
        const hub = createLiveHub();
        const viewer = mockEmit();
        hub.open(viewer.emit, ["agents"]);
        const reads = [
            [phaseRow("claude:s1"), phaseRow("codex:s2", { provider: "codex" })],
            [
                phaseRow("claude:s1", { phase: "waiting", label: "waiting" }),
                phaseRow("codex:s2", { provider: "codex" }),
            ],
            [phaseRow("claude:s1", { phase: "waiting", label: "waiting" })],
        ];
        let at = 0;
        const producer = createAgentsProducer(hub, async () => reads[Math.min(at++, reads.length - 1)]);

        await producer.refresh();
        await producer.refresh();
        await producer.refresh();
        const agents = viewer.frames.filter((frame) => frame.channel === "agents");

        expect(agents.map((frame) => frame.type)).toEqual(["snapshot", "phase", "snapshot"]);
        expect(agents[1]).toMatchObject({ type: "phase", payload: { key: "claude:s1", label: "waiting" } });
        expect(await producer.snapshot?.()).toEqual([
            { v: 1, channel: "agents", type: "snapshot", payload: { sessions: reads[2] } },
        ]);

        producer.stop();
        expect(await producer.snapshot?.()).toEqual([]);
        hub._reset();
    });

    test("reads nothing while nobody subscribes", async () => {
        const hub = createLiveHub();
        let reads = 0;
        const producer = createAgentsProducer(hub, async () => {
            reads++;
            return [];
        });

        await producer.refresh();
        expect(reads).toBe(0);
        hub._reset();
    });
});

describe("decisions producer", () => {
    test("forwards a posted decision and its answer, with the state the update moved it to", async () => {
        const hub = createLiveHub();
        const viewer = mockEmit();
        hub.open(viewer.emit, ["decisions"]);
        const path = join(mkdtempSync(join(tmpdir(), "gt-live-decisions-")), "events.jsonl");
        writeFileSync(path, "");
        const producer = createDecisionsProducer(hub, () => path);
        producer.start();

        try {
            appendFileSync(path, '{"ev":"created","id":"d1","ts":"2026-01-01T00:00:00.000Z"}\n');
            appendFileSync(path, '{"ev":"updated","id":"d1","ts":"2026-01-01T00:01:00.000Z","state":"answered"}\n');
            const deadline = Date.now() + 5_000;

            while (viewer.frames.filter((f) => f.channel === "decisions").length < 2 && Date.now() < deadline) {
                await Bun.sleep(50);
            }

            expect(viewer.frames.filter((f) => f.channel === "decisions").map((f) => f.payload)).toEqual([
                { ev: "created", id: "d1", ts: "2026-01-01T00:00:00.000Z" },
                { ev: "updated", id: "d1", ts: "2026-01-01T00:01:00.000Z", state: "answered" },
            ]);
        } finally {
            producer.stop();
            hub._reset();
        }
    });
});
