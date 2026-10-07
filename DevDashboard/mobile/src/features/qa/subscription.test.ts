import type { DashboardClient, EnrichedQaEntry, QaRow, QaSubscription } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import {
    openQaSubscription,
    pushLiveRow,
    QA_LIVE_WINDOW,
    QA_SEEN_LIMIT,
    type QaLiveStatus,
} from "@/features/qa/subscription";

/**
 * Tests the renderer-free QA subscription controller by mocking the contract's `qa.subscribe` (the
 * single seam — the controller never touches `expo/fetch` directly; the SSE framing is owned + tested
 * by `src/transport/sse-parser.ts`). The fake captures the `onEntry` callback so the test can drive
 * scripted entries through it exactly as the real EventSource adapter would (mirrors how
 * `transport/qa-stream.test.ts` fakes the stream impl), then asserts dedupe, status, and teardown.
 */

interface FakeSubscribeControl {
    emit: (entry: QaRow) => void;
    open: () => void;
    error: () => void;
    closed: () => boolean;
    client: DashboardClient;
}

function fakeClient(): FakeSubscribeControl {
    let handler: ((e: EnrichedQaEntry) => void) | null = null;
    let onOpen: (() => void) | undefined;
    let onError: ((error: unknown) => void) | undefined;
    let isClosed = false;

    const client = {
        qa: {
            subscribe: (
                onEntry: (e: EnrichedQaEntry) => void,
                callbacks: { onOpen?: () => void; onError?: (error: unknown) => void } = {}
            ): QaSubscription => {
                handler = onEntry;
                onOpen = callbacks.onOpen;
                onError = callbacks.onError;
                return {
                    close() {
                        isClosed = true;
                    },
                };
            },
        },
    } as unknown as DashboardClient;

    return {
        client,
        closed: () => isClosed,
        open: () => onOpen?.(),
        error: () => onError?.(new Error("down")),
        emit: (entry) => handler?.(entry as unknown as EnrichedQaEntry),
    };
}

function row(id: string): QaRow {
    // Test-local partial fixture: only the fields the controller reads (id). Cast through unknown —
    // a full QaRow isn't needed to exercise dedupe/status/teardown.
    return { id, question: "q", answerMd: "a", project: "P", tag: "question", refs: [] } as unknown as QaRow;
}

describe("bounded live state", () => {
    it("caps the live window newest-first and still dedupes", () => {
        let live: QaRow[] = [];
        for (let i = 0; i < QA_LIVE_WINDOW + 5; i++) {
            live = pushLiveRow(live, row(String(i)));
        }

        expect(live).toHaveLength(QA_LIVE_WINDOW);
        expect(live[0]?.id).toBe(String(QA_LIVE_WINDOW + 4));
        expect(pushLiveRow(live, row(String(QA_LIVE_WINDOW + 4)))).toBe(live);
    });

    it("forgets the oldest seen id once the dedupe window is full", () => {
        const ctrl = fakeClient();
        const got: string[] = [];
        openQaSubscription(ctrl.client, { onRow: (e) => got.push(e.id) });
        for (let i = 0; i <= QA_SEEN_LIMIT; i++) {
            ctrl.emit(row(String(i)));
        }

        ctrl.emit(row("0"));
        ctrl.emit(row(String(QA_SEEN_LIMIT)));
        expect(got).toHaveLength(QA_SEEN_LIMIT + 2);
    });
});

describe("openQaSubscription", () => {
    it("forwards each new entry to onRow", () => {
        const ctrl = fakeClient();
        const got: string[] = [];
        openQaSubscription(ctrl.client, { onRow: (e) => got.push(e.id) });
        ctrl.emit(row("1"));
        ctrl.emit(row("2"));
        expect(got).toEqual(["1", "2"]);
    });

    it("dedupes a re-delivered id", () => {
        const ctrl = fakeClient();
        const got: string[] = [];
        openQaSubscription(ctrl.client, { onRow: (e) => got.push(e.id) });
        ctrl.emit(row("1"));
        ctrl.emit(row("1"));
        ctrl.emit(row("2"));
        expect(got).toEqual(["1", "2"]);
    });

    it("reports 'connecting' → 'open' on subscribe, then 'live' on the first row", () => {
        const ctrl = fakeClient();
        const statuses: QaLiveStatus[] = [];
        openQaSubscription(ctrl.client, { onRow: () => {}, onStatus: (s) => statuses.push(s) });
        expect(statuses).toEqual(["connecting"]);
        ctrl.open();
        expect(statuses).toEqual(["connecting", "open"]);
        ctrl.emit(row("1"));
        expect(statuses).toEqual(["connecting", "open", "live"]);
    });

    it("reports disconnect and resyncs after a real reconnect", () => {
        const ctrl = fakeClient();
        const statuses: QaLiveStatus[] = [];
        let resyncs = 0;
        openQaSubscription(ctrl.client, {
            onRow: () => {},
            onStatus: (status) => statuses.push(status),
            onReconnect: () => {
                resyncs += 1;
            },
        });

        ctrl.open();
        ctrl.error();
        ctrl.open();

        expect(statuses).toEqual(["connecting", "open", "down", "open"]);
        expect(resyncs).toBe(1);
    });

    it("close() tears down the underlying subscription and is idempotent", () => {
        const ctrl = fakeClient();
        const handle = openQaSubscription(ctrl.client, { onRow: () => {} });
        expect(ctrl.closed()).toBe(false);
        handle.close();
        handle.close();
        expect(ctrl.closed()).toBe(true);
    });

    it("drops entries that arrive after close()", () => {
        const ctrl = fakeClient();
        const got: string[] = [];
        const handle = openQaSubscription(ctrl.client, { onRow: (e) => got.push(e.id) });
        ctrl.emit(row("1"));
        handle.close();
        ctrl.emit(row("2"));
        expect(got).toEqual(["1"]);
    });
});
