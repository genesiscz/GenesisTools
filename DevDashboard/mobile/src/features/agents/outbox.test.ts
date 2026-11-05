import { describe, expect, it, mock } from "bun:test";

// The outbox imports the native key-value store; these tests use the memory store, so the native module is stubbed.
mock.module("expo-sqlite/kv-store", () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { addDraft, flushDrafts, isOfflineError, memoryDraftStore } = await import("@/features/agents/outbox");
type SteerDraft = Parameters<typeof addDraft>[1];

function draft(id: string, createdAt: number): SteerDraft {
    return { id, connectionId: "mac-a", key: "claude:s-1", text: `message ${id}`, timing: "now", createdAt, attempts: 0, lastError: null };
}

const receipt = (key: string) =>
    ({ key, outcome: "delivered", timing: "now", route: "claude-peer", detail: "peer" }) as const;

describe("steer outbox (F10)", () => {
    it("tells a network failure or a down gateway from the Mac's own answer", () => {
        expect(isOfflineError(new TypeError("Network request failed"))).toBe(true);
        expect(isOfflineError(new Error("/api/agents/send -> 503: unavailable"))).toBe(true);
        expect(isOfflineError(new Error("/api/agents/send -> 400: expected { key, text, timing }"))).toBe(false);
    });

    it("sends waiting drafts oldest first with their own key, and keeps what still cannot reach the Mac", async () => {
        const store = memoryDraftStore();
        await addDraft(store, draft("b", 2));
        await addDraft(store, draft("a", 1));
        await addDraft(store, draft("c", 3));
        const keys: string[] = [];

        const result = await flushDrafts({
            store,
            connectionId: "mac-a",
            send: async (entry) => {
                keys.push(entry.id);

                if (entry.id === "b") {
                    throw new TypeError("Network request failed");
                }

                if (entry.id === "c") {
                    throw new Error("/api/agents/send -> 400: bad");
                }

                return receipt(entry.key);
            },
        });

        expect(keys).toEqual(["a", "b", "c"]);
        expect(result.sent.map((entry) => entry.draft.id)).toEqual(["a"]);
        expect(result.failed.map((entry) => entry.draft.id)).toEqual(["c"]);
        expect((await store.read()).map((entry) => [entry.id, entry.attempts])).toEqual([["b", 1]]);
    });

    it("never sends another Mac's prompt or legacy unscoped prompts, and keeps them stored", async () => {
        const store = memoryDraftStore([
            draft("a", 1), { ...draft("b", 2), connectionId: "mac-b" },
            { ...draft("legacy", 3), connectionId: undefined },
        ]);
        const sent: string[] = [];
        await flushDrafts({ store, connectionId: "mac-b", send: async (entry) => {
            sent.push(entry.id);
            return receipt(entry.key);
        } });
        expect(sent).toEqual(["b"]);
        expect((await store.read()).map((entry) => entry.id)).toEqual(["a", "legacy"]);
        await flushDrafts({ store, connectionId: "mac-a", send: async (entry) => {
            sent.push(entry.id);
            return receipt(entry.key);
        } });
        expect(sent).toEqual(["b", "a"]);
        expect((await store.read()).map((entry) => entry.id)).toEqual(["legacy"]);
    });

    it("keeps a draft added while a flush runs", async () => {
        const store = memoryDraftStore([draft("a", 1)]);
        await flushDrafts({
            store,
            connectionId: "mac-a",
            send: async (entry) => {
                await addDraft(store, draft("late", 9));
                return receipt(entry.key);
            },
        });

        expect((await store.read()).map((entry) => entry.id)).toEqual(["late"]);
    });
});
