import { describe, expect, it } from "bun:test";
import {
    createDashboardClient,
    type EventSourceLike,
    type LiveDataFrame,
    type PortInfo,
    type PortsRes,
} from "@dd/contract";
import { QueryClient } from "@tanstack/react-query";
import { mockPulse } from "@/api/fixtures/data";
import { MOCK_BOARD } from "@/api/fixtures/agents";
import { agentsKeys } from "@/features/agents/queries";
import { answerQueueKeys } from "@/features/answer-queue/queries";
import { portKillerKeys } from "@/features/port-killer/queries";
import { pulseKeys } from "@/features/pulse/queries";
import { LIVE_CACHE_TABLE } from "@/live/cache-table";
import { applyLiveFrame, createLiveCache } from "@/live/live-cache";
import { SafeJSON } from "@/shims/safe-json";

function port(pid: number, kind?: PortInfo["kind"]): PortInfo {
    return {
        pid,
        port: 3000 + pid,
        proto: "tcp4",
        command: "node",
        address: "127.0.0.1",
        probeStatus: kind ? "done" : "pending",
        ...(kind ? { kind } : {}),
    };
}

/** A contract client over one fake EventSource; posts are recorded. */
function fakeClient() {
    const urls: string[] = [];
    const posts: string[] = [];
    const sources: EventSourceLike[] = [];
    const client = createDashboardClient({
        baseUrl: "http://mac",
        fetch: (async (url: string, init?: RequestInit) => {
            posts.push(`${url} ${String(init?.body)}`);
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        eventSourceFactory: (url) => {
            urls.push(url);
            const source: EventSourceLike = { close: () => {}, onmessage: null, onopen: null, onerror: null };
            sources.push(source);
            return source;
        },
    });

    function send(frame: unknown): void {
        sources.at(-1)?.onmessage?.({ data: SafeJSON.stringify(frame) });
    }

    function hello(connId: string, channels: string[]): void {
        send({ v: 1, channel: "system", type: "hello", payload: { connId, channels } });
    }

    return { client, urls, posts, sources, send, hello };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the live cache table", () => {
    it("maps a pulse snapshot to the pulse query key", () => {
        const queryClient = new QueryClient();
        const payload = mockPulse();
        applyLiveFrame(LIVE_CACHE_TABLE, { v: 1, channel: "pulse", type: "snapshot", payload }, queryClient);

        expect(queryClient.getQueryData<unknown>(pulseKeys.snap)).toEqual(payload);
    });

    it("writes a ports snapshot, then merges a classify batch into it by pid, port and protocol", () => {
        const queryClient = new QueryClient();
        const snapshot: LiveDataFrame = {
            v: 1,
            channel: "ports",
            type: "snapshot",
            payload: { lsofAvailable: true, ports: [port(1), port(2)], scannedAt: 1 },
        };
        applyLiveFrame(LIVE_CACHE_TABLE, snapshot, queryClient);
        applyLiveFrame(
            LIVE_CACHE_TABLE,
            { v: 1, channel: "ports", type: "classify", payload: { ports: [port(2, "web")] } },
            queryClient
        );

        const ports = queryClient.getQueryData<PortsRes>(portKillerKeys.list)?.ports ?? [];
        expect(ports.map((p) => p.kind)).toEqual([undefined, "web"]);
    });

    it("a decision notice invalidates the waiting queue", async () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(answerQueueKeys.queue, { sessions: [] });
        applyLiveFrame(
            LIVE_CACHE_TABLE,
            { v: 1, channel: "decisions", type: "event", payload: { ev: "created", id: "d1", ts: "t" } },
            queryClient
        );

        expect(queryClient.getQueryState(answerQueueKeys.queue)?.isInvalidated).toBe(true);
    });

    it("an agents phase frame patches its session on the board; an unknown session refetches the board", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(agentsKeys.board, MOCK_BOARD);
        const first = MOCK_BOARD.sessions[0];
        applyLiveFrame(
            LIVE_CACHE_TABLE,
            { v: 1, channel: "agents", type: "phase", payload: { ...first, phase: "waiting", label: "waiting" } },
            queryClient
        );

        const board = queryClient.getQueryData<typeof MOCK_BOARD>(agentsKeys.board);
        expect(board?.sessions[0]).toMatchObject({ key: first.key, label: "waiting", project: first.project });
        expect(queryClient.getQueryState(agentsKeys.board)?.isInvalidated).toBe(false);

        applyLiveFrame(
            LIVE_CACHE_TABLE,
            { v: 1, channel: "agents", type: "phase", payload: { ...first, key: "claude:new" } },
            queryClient
        );
        expect(queryClient.getQueryState(agentsKeys.board)?.isInvalidated).toBe(true);
    });

    it("an agents snapshot with a session that ended refetches the board", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(agentsKeys.board, MOCK_BOARD);
        applyLiveFrame(
            LIVE_CACHE_TABLE,
            { v: 1, channel: "agents", type: "snapshot", payload: { sessions: MOCK_BOARD.sessions.slice(1) } },
            queryClient
        );

        expect(queryClient.getQueryState(agentsKeys.board)?.isInvalidated).toBe(true);
    });
});

describe("createLiveCache", () => {
    it("opens one stream for the demanded channels, moves the set in place, and closes when demand ends", async () => {
        const fake = fakeClient();
        const cache = createLiveCache({ client: fake.client, queryClient: new QueryClient() });

        const releasePulse = cache.demand("pulse");
        const releaseQa = cache.demand("qa");
        await tick();
        expect(fake.urls).toEqual(["http://mac/api/live?channels=pulse%2Cqa"]);
        expect(cache.status()).toBe("connecting");

        fake.hello("c1", ["pulse", "qa"]);
        expect(cache.status()).toBe("live");
        expect(cache.isLive("pulse")).toBe(true);

        releaseQa();
        await tick();
        expect(fake.urls).toHaveLength(1);
        expect(fake.posts.at(-1)).toBe('http://mac/api/live/subscribe {"connId":"c1","channels":["pulse"]}');
        expect(cache.isLive("qa")).toBe(false);

        releasePulse();
        await tick();
        expect(cache.status()).toBe("off");
    });

    it("a screen swap inside one turn does not reopen the stream", async () => {
        const fake = fakeClient();
        const cache = createLiveCache({ client: fake.client, queryClient: new QueryClient() });

        const release = cache.demand("pulse");
        await tick();
        release();
        cache.demand("pulse");
        await tick();

        expect(fake.urls).toHaveLength(1);
    });

    it("writes frames of streamed channels into the query cache", async () => {
        const fake = fakeClient();
        const queryClient = new QueryClient();
        const cache = createLiveCache({ client: fake.client, queryClient });
        cache.demand("pulse");
        await tick();
        fake.hello("c1", ["pulse"]);
        fake.send({ v: 1, channel: "pulse", type: "snapshot", payload: { ts: 9 } });

        expect(queryClient.getQueryData<unknown>(pulseKeys.snap)).toEqual({ ts: 9 });
    });

    it("refetches a notice channel's queries when a connection opens", async () => {
        const fake = fakeClient();
        const queryClient = new QueryClient();
        queryClient.setQueryData(answerQueueKeys.queue, { sessions: [] });
        const cache = createLiveCache({ client: fake.client, queryClient });
        cache.demand("decisions");
        await tick();
        fake.hello("c1", ["decisions"]);

        expect(queryClient.getQueryState(answerQueueKeys.queue)?.isInvalidated).toBe(true);
    });

    it("holds no stream in the background and reopens on return", async () => {
        const fake = fakeClient();
        const cache = createLiveCache({ client: fake.client, queryClient: new QueryClient() });
        cache.demand("pulse");
        await tick();

        cache.setForeground(false);
        await tick();
        expect(cache.status()).toBe("off");

        cache.setForeground(true);
        await tick();
        expect(fake.urls).toHaveLength(2);
    });

    it("reports a dropped stream as down, so screens fall back to polling", async () => {
        const fake = fakeClient();
        const cache = createLiveCache({ client: fake.client, queryClient: new QueryClient() });
        cache.demand("pulse");
        await tick();
        fake.hello("c1", ["pulse"]);
        fake.sources[0]?.onerror?.(new Error("dropped"));

        expect(cache.status()).toBe("down");
        expect(cache.isLive("pulse")).toBe(false);
    });
});
