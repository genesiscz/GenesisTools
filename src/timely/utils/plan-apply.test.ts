import { afterEach, describe, expect, test } from "bun:test";
import { TimelyHttpError } from "@app/timely/api/errors";
import type { Duration, TimelyEntry } from "@app/timely/types/api";
import type { CreatePlanV1 } from "@app/timely/types/plan";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { applyPlan } from "./plan-apply";

setupStorageSandbox();

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function duration(formatted = "00:10"): Duration {
    return {
        hours: 0,
        minutes: 10,
        seconds: 0,
        formatted,
        total_hours: 1 / 6,
        total_seconds: 600,
        total_minutes: 10,
    };
}

function memory(id: number): TimelyEntry {
    return {
        id,
        type: "memory",
        uid: `memory-${id}`,
        title: `Memory ${id}`,
        note: "",
        description: "",
        date: "2026-07-20",
        from: "2026-07-20T09:00:00.000Z",
        to: "2026-07-20T09:10:00.000Z",
        entry_type: null,
        duration: duration(),
        at: "",
        extra_attributes: [],
        icon: null,
        color: null,
        sub_entries: [],
        icon_url: "",
        icon_fallback_url: "",
        url: "",
    };
}

function plan(memoryIds: number[]): CreatePlanV1 {
    return {
        version: 1,
        generated_at: "2026-07-21T00:00:00.000Z",
        days: [
            {
                day: "2026-07-20",
                available_memories: memoryIds.map((id) => ({
                    id,
                    app: "Editor",
                    note: `Memory ${id}`,
                    from: "2026-07-20T09:00:00.000Z",
                    to: "2026-07-20T09:10:00.000Z",
                    duration_min: 10,
                    sub_notes: [],
                })),
                suggestions: [],
                events: memoryIds.map((id) => ({ project_id: 10, note: `Event ${id}`, memory_ids: [id] })),
            },
        ],
    };
}

function stubMemories(entries: TimelyEntry[]): void {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(SafeJSON.stringify(entries), { status: 200 })) as typeof fetch;
}

describe("applyPlan receipts", () => {
    test("reuses a confirmed successful event while a failed event remains retryable", async () => {
        stubMemories([memory(1)]);
        const storage = new Storage("timely-apply-receipt-partial-test");
        let createCalls = 0;
        const service = {
            createEvent: async () => ({ id: 700 + ++createCalls, duration: duration() }),
        };

        const first = await applyPlan({
            plan: plan([1, 2]),
            service,
            storage,
            accountId: 111,
            accessToken: "test-token",
            dryRun: false,
        });
        const retry = await applyPlan({
            plan: plan([1, 2]),
            service,
            storage,
            accountId: 111,
            accessToken: "test-token",
            dryRun: false,
        });

        expect(first[0].eventId).toBe(701);
        expect(first[1].error).toContain("not found");
        expect(retry[0]).toMatchObject({ eventId: 701, alreadyApplied: true });
        expect(retry[1].error).toContain("not found");
        expect(createCalls).toBe(1);
    });

    test("normal first apply creates every event and dry-run creates no receipt", async () => {
        stubMemories([memory(1), memory(2)]);
        const storage = new Storage("timely-apply-receipt-normal-test");
        let createCalls = 0;
        const service = {
            createEvent: async () => ({ id: 800 + ++createCalls, duration: duration() }),
        };

        const dry = await applyPlan({
            plan: plan([1, 2]),
            service,
            storage,
            accountId: 222,
            accessToken: "test-token",
            dryRun: true,
        });
        expect(dry).toHaveLength(2);
        expect(createCalls).toBe(0);
        expect((await storage.listCacheFiles()).some((file) => file.includes("apply-receipts"))).toBe(false);

        const applied = await applyPlan({
            plan: plan([1, 2]),
            service,
            storage,
            accountId: 222,
            accessToken: "test-token",
            dryRun: false,
        });
        expect(applied.map((result) => result.eventId)).toEqual([801, 802]);
        expect(createCalls).toBe(2);
    });

    test("does not repost an event after an ambiguous create failure", async () => {
        stubMemories([memory(1)]);
        const storage = new Storage("timely-apply-receipt-ambiguous-test");
        let createCalls = 0;
        const service = {
            createEvent: async () => {
                createCalls++;
                throw new Error("connection closed after upload");
            },
        };

        const options = {
            plan: plan([1]),
            service,
            storage,
            accountId: 333,
            accessToken: "test-token",
            dryRun: false,
        };
        const first = await applyPlan(options);
        const retry = await applyPlan(options);

        expect(first[0].error).toContain("connection closed");
        expect(retry[0].error).toContain("no unique remote event matched");
        expect(createCalls).toBe(1);
    });

    test("reconciles an ambiguous create against the remote day before retrying", async () => {
        stubMemories([memory(1)]);
        const storage = new Storage("timely-apply-receipt-reconcile-test");
        let createCalls = 0;
        const remoteEvent = {
            id: 950,
            day: "2026-07-20",
            project: { id: 10 },
            note: "Event 1",
            from: "2026-07-20T09:00:00.000Z",
            to: "2026-07-20T09:10:00.000Z",
            duration: duration(),
        };
        const service = {
            createEvent: async () => {
                createCalls++;
                throw new Error("connection closed after upload");
            },
            getAllEvents: async () => [remoteEvent],
        };
        const options = {
            plan: plan([1]),
            service,
            storage,
            accountId: 555,
            accessToken: "test-token",
            dryRun: false,
        };

        await applyPlan(options);
        const retry = await applyPlan(options);

        expect(retry[0]).toMatchObject({ eventId: 950, alreadyApplied: true });
        expect(createCalls).toBe(1);
    });

    test("a pending receipt survives a cache clear, so the retry reconciles instead of posting again", async () => {
        stubMemories([memory(1)]);
        const storage = new Storage("timely-apply-receipt-cache-clear-test");
        let createCalls = 0;
        const remoteEvent = {
            id: 952,
            day: "2026-07-20",
            project: { id: 10 },
            note: "Event 1",
            from: "2026-07-20T09:00:00.000Z",
            to: "2026-07-20T09:10:00.000Z",
            duration: duration(),
        };
        const service = {
            createEvent: async () => {
                createCalls++;
                throw new Error("connection closed after upload");
            },
            getAllEvents: async () => [remoteEvent],
        };
        const options = {
            plan: plan([1]),
            service,
            storage,
            accountId: 557,
            accessToken: "test-token",
            dryRun: false,
        };

        await applyPlan(options);
        await storage.clearCache();
        const retry = await applyPlan(options);

        expect(retry[0]).toMatchObject({ eventId: 952, alreadyApplied: true });
        expect(createCalls).toBe(1);
    });

    test("does not adopt a remote event with the same bounds but a different billed duration", async () => {
        stubMemories([memory(1)]);
        const storage = new Storage("timely-apply-receipt-duration-test");
        const remoteEvent = {
            id: 951,
            day: "2026-07-20",
            project: { id: 10 },
            note: "Event 1",
            from: "2026-07-20T09:00:00.000Z",
            to: "2026-07-20T09:10:00.000Z",
            duration: { ...duration("00:04"), minutes: 4, total_seconds: 240, total_minutes: 4 },
        };
        const service = {
            createEvent: async () => {
                throw new Error("connection closed after upload");
            },
            getAllEvents: async () => [remoteEvent],
        };
        const options = {
            plan: plan([1]),
            service,
            storage,
            accountId: 556,
            accessToken: "test-token",
            dryRun: false,
        };

        await applyPlan(options);
        const retry = await applyPlan(options);

        expect(retry[0].eventId).toBeUndefined();
        expect(retry[0].error).toContain("no unique remote event matched");
    });

    test("retries only a definitively rejected event after a partial apply", async () => {
        stubMemories([memory(1), memory(2)]);
        const storage = new Storage("timely-apply-receipt-rejected-test");
        let createCalls = 0;
        let rejected = false;
        const service = {
            createEvent: async (_accountId: number, input: { note?: string }) => {
                createCalls++;

                if (input.note === "Event 2" && !rejected) {
                    rejected = true;
                    throw new TimelyHttpError("invalid payload", { status: 422, scope: "api" });
                }

                return { id: 900 + createCalls, duration: duration() };
            },
        };
        const options = {
            plan: plan([1, 2]),
            service,
            storage,
            accountId: 444,
            accessToken: "test-token",
            dryRun: false,
        };

        const first = await applyPlan(options);
        const retry = await applyPlan(options);

        expect(first[0].eventId).toBe(901);
        expect(first[1].error).toContain("invalid payload");
        expect(retry[0]).toMatchObject({ eventId: 901, alreadyApplied: true });
        expect(retry[1].eventId).toBe(903);
        expect(createCalls).toBe(3);
    });
});
