import type { DashboardClient, EnrichedQaEntry, QaRow, QaSubscription } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { openQaSubscription, type QaLiveStatus } from "@/features/qa/subscription";

/**
 * Tests the renderer-free QA subscription controller by mocking the contract's `qa.subscribe` (the
 * single seam — the controller never touches `expo/fetch` directly; the SSE framing is owned + tested
 * by `src/transport/sse-parser.ts`). The fake captures the `onEntry` callback so the test can drive
 * scripted entries through it exactly as the real EventSource adapter would (mirrors how
 * `transport/qa-stream.test.ts` fakes the stream impl), then asserts dedupe, status, and teardown.
 */

interface FakeSubscribeControl {
    emit: (entry: QaRow) => void;
    closed: () => boolean;
    client: DashboardClient;
}

function fakeClient(): FakeSubscribeControl {
    let handler: ((e: EnrichedQaEntry) => void) | null = null;
    let isClosed = false;

    const client = {
        qa: {
            subscribe: (onEntry: (e: EnrichedQaEntry) => void): QaSubscription => {
                handler = onEntry;
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
        emit: (entry) => handler?.(entry as unknown as EnrichedQaEntry),
    };
}

function row(id: string): QaRow {
    // Test-local partial fixture: only the fields the controller reads (id). Cast through unknown —
    // a full QaRow isn't needed to exercise dedupe/status/teardown.
    return { id, question: "q", answerMd: "a", project: "P", tag: "question", refs: [] } as unknown as QaRow;
}

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
        // "open" is reported synchronously once the subscription is created (no `onopen` seam), so an
        // idle-but-connected agent reads connected without waiting for a row.
        expect(statuses).toEqual(["connecting", "open"]);
        ctrl.emit(row("1"));
        expect(statuses).toEqual(["connecting", "open", "live"]);
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
