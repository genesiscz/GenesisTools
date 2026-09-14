import { describe, expect, spyOn, test } from "bun:test";
import type { AskForm } from "@app/question/lib/pending/types";
import { applyPendingFrame, mergePendingSnapshot, nextPendingSequence } from "./qa-pending-merge";

function form(id: string, status: AskForm["status"] = "pending", createdAt = 1000): AskForm {
    return {
        id,
        createdAt,
        status,
        projectPath: "/repo",
        cwd: "/repo",
        items: [{ id: "q1", promptMarkdown: "Ship?" }],
    };
}

const NOTHING_RESOLVED = new Set<string>();
const NO_SSE = new Map<string, number>();

describe("mergePendingSnapshot", () => {
    test("a snapshot row is shown", () => {
        const next = mergePendingSnapshot({
            snapshot: [form("a")],
            previous: new Map(),
            resolved: NOTHING_RESOLVED,
            lastSseAt: NO_SSE,
            fetchedAt: 100,
        });

        expect([...next.keys()]).toEqual(["a"]);
    });

    test("a form the stream already resolved is NOT resurrected by an older snapshot", () => {
        // The snapshot was requested before the answer landed, so it still lists the form.
        const next = mergePendingSnapshot({
            snapshot: [form("a")],
            previous: new Map(),
            resolved: new Set(["a"]),
            lastSseAt: NO_SSE,
            fetchedAt: 100,
        });

        expect(next.has("a")).toBe(false);
    });

    test("a form missing from the snapshot is REMOVED, not kept forever", () => {
        // Another client answered it while this tab's stream was down, so no frame ever
        // arrived and it is simply absent from every later snapshot.
        const next = mergePendingSnapshot({
            snapshot: [],
            previous: new Map([["a", form("a")]]),
            resolved: NOTHING_RESOLVED,
            lastSseAt: NO_SSE,
            fetchedAt: 100,
        });

        expect(next.has("a")).toBe(false);
    });

    test("a form the stream delivered AFTER the snapshot survives it", () => {
        const next = mergePendingSnapshot({
            snapshot: [],
            previous: new Map([["b", form("b")]]),
            resolved: NOTHING_RESOLVED,
            lastSseAt: new Map([["b", 150]]),
            fetchedAt: 100,
        });

        expect(next.has("b")).toBe(true);
    });

    test("a stream arrival OLDER than the snapshot does not keep a gone form alive", () => {
        const next = mergePendingSnapshot({
            snapshot: [],
            previous: new Map([["b", form("b")]]),
            resolved: NOTHING_RESOLVED,
            lastSseAt: new Map([["b", 50]]),
            fetchedAt: 100,
        });

        expect(next.has("b")).toBe(false);
    });
});

describe("nextPendingSequence", () => {
    test("two calls in the same tick never tie, even when Date.now() does", () => {
        const spy = spyOn(Date, "now").mockReturnValue(1_726_000_000_000);

        try {
            const first = nextPendingSequence();
            const second = nextPendingSequence();

            expect(second).toBeGreaterThan(first);
        } finally {
            spy.mockRestore();
        }
    });

    test("an SSE frame stamped after the request survives the merge on a frozen clock", () => {
        // Reproduces the CodeRabbit finding directly: if both markers came from `Date.now()`
        // while the clock is frozen mid-millisecond, `fetchedAt === lastSseAt` and the merge's
        // strict `>` would drop the form. The sequence-based markers cannot tie.
        const spy = spyOn(Date, "now").mockReturnValue(1_726_000_000_000);

        try {
            const fetchedAt = nextPendingSequence();
            const lastSseAt = nextPendingSequence();

            const next = mergePendingSnapshot({
                snapshot: [],
                previous: new Map([["b", form("b")]]),
                resolved: NOTHING_RESOLVED,
                lastSseAt: new Map([["b", lastSseAt]]),
                fetchedAt,
            });

            expect(next.has("b")).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("applyPendingFrame", () => {
    test("a pending frame shows the form", () => {
        const next = applyPendingFrame(new Map(), { id: "a", form: form("a") }, new Set());

        expect(next.get("a")?.id).toBe("a");
    });

    test("a resolved frame removes the form and records a tombstone", () => {
        const resolved = new Set<string>();
        const next = applyPendingFrame(new Map([["a", form("a")]]), { id: "a", form: form("a", "answered") }, resolved);

        expect(next.has("a")).toBe(false);
        expect(resolved.has("a")).toBe(true);
    });

    test("a duplicate created frame cannot revive an already resolved form", () => {
        // The server now attaches its tailer before reading the snapshot, which makes this
        // duplicate possible by design.
        const resolved = new Set(["a"]);
        const next = applyPendingFrame(new Map(), { id: "a", form: form("a") }, resolved);

        expect(next.has("a")).toBe(false);
    });
});
