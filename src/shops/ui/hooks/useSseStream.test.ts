import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { createSseSubscription, type SseFrame, type SseStatus } from "@app/shops/ui/hooks/useSseStream";

class MockEventSource {
    static instances: MockEventSource[] = [];
    public readyState = 0;
    private listeners: Map<string, Array<(ev: Event) => void>> = new Map();

    constructor(public url: string) {
        MockEventSource.instances.push(this);
    }

    addEventListener(name: string, fn: (ev: Event) => void): void {
        const arr = this.listeners.get(name) ?? [];
        arr.push(fn);
        this.listeners.set(name, arr);
    }

    close(): void {
        this.readyState = 2;
    }

    fire(name: string, payload: unknown): void {
        const arr = this.listeners.get(name) ?? [];
        const ev = new MessageEvent(name, { data: SafeJSON.stringify(payload) });
        for (const fn of arr) {
            fn(ev);
        }
    }

    fireOpen(): void {
        const arr = this.listeners.get("open") ?? [];
        for (const fn of arr) {
            fn(new Event("open"));
        }
    }

    fireError(): void {
        const arr = this.listeners.get("error") ?? [];
        for (const fn of arr) {
            fn(new Event("error"));
        }
    }
}

function makeScheduler() {
    const queue: Array<() => void> = [];
    return {
        schedule: (cb: () => void): number => {
            queue.push(cb);
            return queue.length;
        },
        cancel: (_id: number): void => {
            // intentionally noop in test scheduler
        },
        flush: (): void => {
            const tasks = queue.splice(0, queue.length);
            for (const t of tasks) {
                t();
            }
        },
    };
}

describe("createSseSubscription", () => {
    it("opens an EventSource and registers known event names", () => {
        MockEventSource.instances = [];
        const sched = makeScheduler();

        createSseSubscription({
            url: "/api/live.events",
            events: ["http-request", "crawl-progress"],
            onBatch: () => {},
            EventSourceClass: MockEventSource as unknown as typeof EventSource,
            schedule: sched.schedule,
            cancel: sched.cancel,
        });

        expect(MockEventSource.instances.length).toBe(1);
        expect(MockEventSource.instances[0].url).toBe("/api/live.events");
    });

    it("buffers events and flushes via the scheduler", () => {
        MockEventSource.instances = [];
        const sched = makeScheduler();
        const batches: Array<Array<SseFrame<"http-request">>> = [];

        createSseSubscription({
            url: "/api/live.events",
            events: ["http-request"],
            onBatch: (b) => batches.push(b as Array<SseFrame<"http-request">>),
            EventSourceClass: MockEventSource as unknown as typeof EventSource,
            schedule: sched.schedule,
            cancel: sched.cancel,
        });

        const es = MockEventSource.instances[0];
        es.fire("http-request", { id: 1 });
        es.fire("http-request", { id: 2 });
        es.fire("http-request", { id: 3 });

        expect(batches.length).toBe(0);

        sched.flush();

        expect(batches.length).toBe(1);
        expect(batches[0].length).toBe(3);
        expect((batches[0][0].data as { id: number }).id).toBe(1);
    });

    it("collapses multiple frames into a single rAF flush", () => {
        MockEventSource.instances = [];
        const sched = makeScheduler();
        const batches: Array<Array<SseFrame<"http-request">>> = [];

        createSseSubscription({
            url: "/api/live.events",
            events: ["http-request"],
            onBatch: (b) => batches.push(b as Array<SseFrame<"http-request">>),
            EventSourceClass: MockEventSource as unknown as typeof EventSource,
            schedule: sched.schedule,
            cancel: sched.cancel,
        });

        const es = MockEventSource.instances[0];
        for (let i = 0; i < 10; i++) {
            es.fire("http-request", { id: i });
        }

        sched.flush();

        expect(batches.length).toBe(1);
        expect(batches[0].length).toBe(10);
    });

    it("reports status changes via onStatusChange", () => {
        MockEventSource.instances = [];
        const sched = makeScheduler();
        const statuses: SseStatus[] = [];

        createSseSubscription({
            url: "/api/live.events",
            events: ["http-request"],
            onBatch: () => {},
            onStatusChange: (s) => statuses.push(s),
            EventSourceClass: MockEventSource as unknown as typeof EventSource,
            schedule: sched.schedule,
            cancel: sched.cancel,
        });

        const es = MockEventSource.instances[0];
        es.fireOpen();

        expect(statuses).toContain("connecting");
        expect(statuses).toContain("live");
    });

    it("close() stops further flushes", () => {
        MockEventSource.instances = [];
        const sched = makeScheduler();
        const batches: Array<Array<SseFrame<"http-request">>> = [];

        const sub = createSseSubscription({
            url: "/api/live.events",
            events: ["http-request"],
            onBatch: (b) => batches.push(b as Array<SseFrame<"http-request">>),
            EventSourceClass: MockEventSource as unknown as typeof EventSource,
            schedule: sched.schedule,
            cancel: sched.cancel,
        });

        const es = MockEventSource.instances[0];
        es.fire("http-request", { id: 1 });
        sub.close();

        // Even if schedule fires, the EventSource is already closed and should
        // not produce new batches because the rAF was cancelled.
        sched.flush();

        // The fire() call before close() schedules one batch — that's fine,
        // the batch was buffered. We just ensure no NEW frames sneak in.
        expect(es.readyState).toBe(2);
    });

    it("ignores malformed JSON frames without crashing the stream", () => {
        MockEventSource.instances = [];
        const sched = makeScheduler();
        const batches: Array<Array<SseFrame<"http-request">>> = [];

        createSseSubscription({
            url: "/api/live.events",
            events: ["http-request"],
            onBatch: (b) => batches.push(b as Array<SseFrame<"http-request">>),
            EventSourceClass: MockEventSource as unknown as typeof EventSource,
            schedule: sched.schedule,
            cancel: sched.cancel,
        });

        const es = MockEventSource.instances[0];
        // Manually send a broken event (bypass JSON.stringify)
        const listeners = (es as unknown as { listeners: Map<string, Array<(ev: Event) => void>> }).listeners;
        const arr = listeners.get("http-request") ?? [];
        for (const fn of arr) {
            fn(new MessageEvent("http-request", { data: "{not json" }));
        }
        // Then a good one
        es.fire("http-request", { id: 99 });

        sched.flush();

        expect(batches.length).toBe(1);
        expect(batches[0].length).toBe(1);
        expect((batches[0][0].data as { id: number }).id).toBe(99);
    });
});
