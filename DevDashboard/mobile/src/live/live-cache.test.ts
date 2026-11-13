import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import {
    createDashboardClient,
    type EventSourceLike,
    type LiveDataFrame,
    type LiveFrameOf,
    type PortInfo,
    type PortsRes,
    type QaRow,
} from "@dd/contract";
import { QueryClient } from "@tanstack/react-query";
import { mockPulse } from "@/api/fixtures/data";
import { MOCK_BOARD } from "@/api/fixtures/agents";
import { agentsKeys } from "@/features/agents/queries";
import { answerQueueKeys } from "@/features/answer-queue/queries";
import { portKillerKeys } from "@/features/port-killer/queries";
import {
    EMPTY_QA_LIVE_WINDOW,
    pushLiveRow,
    QA_LIVE_WINDOW,
    QA_SEEN_LIMIT,
    type QaLiveWindow,
    qaLiveStatus,
} from "@/features/qa/live-feed";
import { qaKeys } from "@/features/qa/queries";
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
        expect(queryClient.getQueryState(agentsKeys.board)?.isInvalidated).toBe(true);

        applyLiveFrame(
            LIVE_CACHE_TABLE,
            { v: 1, channel: "agents", type: "phase", payload: { ...first, key: "claude:new" } },
            queryClient
        );
        expect(queryClient.getQueryState(agentsKeys.board)?.isInvalidated).toBe(true);
    });

    it("same-membership snapshots invalidate metadata absent from the phase payload", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(agentsKeys.board, MOCK_BOARD);
        applyLiveFrame(LIVE_CACHE_TABLE, {
            v: 1, channel: "agents", type: "snapshot", payload: { sessions: MOCK_BOARD.sessions },
        }, queryClient);
        expect(queryClient.getQueryState(agentsKeys.board)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryData(agentsKeys.board)).toMatchObject({ sessions: MOCK_BOARD.sessions });
    });

    it("a phase or snapshot row for a worker folded under its parent patches that child's label", () => {
        const queryClient = new QueryClient();
        const [first, ...rest] = MOCK_BOARD.sessions;
        const workerKey = "codex:cccccccc-0000-4000-8000-000000000003";
        const worker = { ...first.children[0], id: "w1", liveLabel: "thinking" as const, liveKey: workerKey };
        const board = { ...MOCK_BOARD, sessions: [{ ...first, children: [worker] }, ...rest] };
        const workerRow = { ...first, key: workerKey, sessionId: workerKey.slice(6), label: "tool" as const };
        queryClient.setQueryData(agentsKeys.board, board);

        applyLiveFrame(LIVE_CACHE_TABLE, { v: 1, channel: "agents", type: "phase", payload: workerRow }, queryClient);
        const afterPhase = queryClient.getQueryData<typeof board>(agentsKeys.board);
        expect(afterPhase?.sessions[0].children[0]).toMatchObject({ id: "w1", liveLabel: "tool" });
        expect(afterPhase?.sessions[0].label).toBe(first.label);

        const snapshot = [...board.sessions, { ...workerRow, label: "waiting" as const }];
        applyLiveFrame(
            LIVE_CACHE_TABLE,
            { v: 1, channel: "agents", type: "snapshot", payload: { sessions: snapshot } },
            queryClient
        );
        expect(queryClient.getQueryData<typeof board>(agentsKeys.board)?.sessions[0].children[0].liveLabel).toBe(
            "waiting"
        );
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

/** A QA row with only the fields the window reads (id). */
function qaRow(id: string): QaRow {
    return { id, question: "q", answerMd: "a", project: "P", tag: "question", refs: [] } as unknown as QaRow;
}

function qaEntryFrame(id: string): LiveDataFrame {
    return { v: 1, channel: "qa", type: "entry", payload: qaRow(id) as unknown as LiveFrameOf<"qa">["payload"] };
}

function qaWindow(queryClient: QueryClient): QaLiveWindow | undefined {
    return queryClient.getQueryData<QaLiveWindow>(qaKeys.live);
}

describe("the qa channel's live window (was features/qa/subscription.test.ts)", () => {
    it("caps the live window newest-first and still dedupes", () => {
        let live = EMPTY_QA_LIVE_WINDOW;
        for (let i = 0; i < QA_LIVE_WINDOW + 5; i++) {
            live = pushLiveRow(live, qaRow(String(i)));
        }

        expect(live.rows).toHaveLength(QA_LIVE_WINDOW);
        expect(live.rows[0]?.id).toBe(String(QA_LIVE_WINDOW + 4));
        expect(pushLiveRow(live, qaRow(String(QA_LIVE_WINDOW + 4)))).toBe(live);
    });

    it("forgets the oldest seen id once the dedupe window is full", () => {
        const queryClient = new QueryClient();
        for (let i = 0; i <= QA_SEEN_LIMIT; i++) {
            applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame(String(i)), queryClient);
        }

        applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame("0"), queryClient);
        expect(qaWindow(queryClient)?.rows[0]?.id).toBe("0");
        const afterForgotten = qaWindow(queryClient);
        applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame(String(QA_SEEN_LIMIT)), queryClient);
        expect(qaWindow(queryClient)).toBe(afterForgotten);
    });

    it("an entry joins the window newest first and refetches the log", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(qaKeys.log(), []);
        applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame("1"), queryClient);
        applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame("2"), queryClient);

        expect(qaWindow(queryClient)?.rows.map((row) => row.id)).toEqual(["2", "1"]);
        expect(queryClient.getQueryState(qaKeys.log())?.isInvalidated).toBe(true);
    });

    it("drops a re-delivered id", () => {
        const queryClient = new QueryClient();
        applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame("1"), queryClient);
        applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame("1"), queryClient);
        applyLiveFrame(LIVE_CACHE_TABLE, qaEntryFrame("2"), queryClient);

        expect(qaWindow(queryClient)?.rows.map((row) => row.id)).toEqual(["2", "1"]);
    });

    it("reports 'connecting' until the stream carries qa, then 'open', then 'live' after the first row", () => {
        expect(qaLiveStatus("off", false, 0)).toBe("connecting");
        expect(qaLiveStatus("connecting", false, 0)).toBe("connecting");
        expect(qaLiveStatus("live", true, 0)).toBe("open");
        expect(qaLiveStatus("live", true, 1)).toBe("live");
    });

    it("reports a drop as down, and a reconnect refetches the log", async () => {
        expect(qaLiveStatus("down", false, 3)).toBe("down");
        const fake = fakeClient();
        const queryClient = new QueryClient();
        const cache = createLiveCache({ client: fake.client, queryClient });
        cache.demand("qa");
        await tick();
        fake.hello("c1", ["qa"]);
        fake.send(qaEntryFrame("1"));
        fake.sources[0]?.onerror?.(new Error("down"));
        expect(cache.status()).toBe("down");
        queryClient.setQueryData(qaKeys.log(), []);
        fake.hello("c2", ["qa"]);

        expect(cache.status()).toBe("live");
        expect(queryClient.getQueryState(qaKeys.log())?.isInvalidated).toBe(true);
        expect(qaWindow(queryClient)?.rows.map((row) => row.id)).toEqual(["1"]);
        cache.close();
    });

    it("drops entries that arrive after close()", async () => {
        const fake = fakeClient();
        const queryClient = new QueryClient();
        const cache = createLiveCache({ client: fake.client, queryClient });
        cache.demand("qa");
        await tick();
        fake.hello("c1", ["qa"]);
        fake.send(qaEntryFrame("1"));
        cache.close();
        fake.send(qaEntryFrame("2"));

        expect(qaWindow(queryClient)?.rows.map((row) => row.id)).toEqual(["1"]);
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

    it("resyncs a notice channel added to an open pulse stream", async () => {
        const fake = fakeClient();
        const queryClient = new QueryClient();
        const cache = createLiveCache({ client: fake.client, queryClient });
        cache.demand("pulse");
        await tick();
        fake.hello("c1", ["pulse"]);
        queryClient.setQueryData(answerQueueKeys.queue, { sessions: [] });
        cache.demand("decisions");
        await tick();
        expect(fake.urls).toHaveLength(1);
        expect(queryClient.getQueryState(answerQueueKeys.queue)?.isInvalidated).toBe(true);
        cache.close();
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

it("keeps hooks usable before the provider is mounted and accepts the provider composition", async () => {
    mock.module("react-native", () => ({ View: "View", Text: "Text", TextInput: "TextInput", Pressable: "View", StyleSheet: { flatten: (style: unknown) => style ?? {} }, AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) } }));
    const fake = fakeClient();
    mock.module("@/api/client-provider", () => ({ useDashboardClient: () => fake.client }));
    const { createElement } = await import("react");
    const { QueryClientProvider } = await import("@tanstack/react-query");
    const { renderHook } = await import("@testing-library/react-native/pure");
    const { LiveCacheProvider, useLiveRefetchInterval, useLiveStatus } = await import("./provider");
    const bare = await renderHook(() => ({ interval: useLiveRefetchInterval("pulse"), status: useLiveStatus() }));
    expect(bare.result.current.status).toBe("off");
    expect(bare.result.current.interval).toBe(LIVE_CACHE_TABLE.pulse.fallbackMs ?? false);
    await bare.unmount();
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, createElement(LiveCacheProvider, null, children));
    const mounted = await renderHook(() => useLiveRefetchInterval("pulse"), { wrapper });
    expect(mounted.result.current).toBe(LIVE_CACHE_TABLE.pulse.fallbackMs ?? false);
    await mounted.unmount();
    queryClient.clear();
});
