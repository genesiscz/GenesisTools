import { describe, expect, it, mock } from "bun:test";

// The outbox imports the native key-value store; these tests use the memory store, so the native module is stubbed.
mock.module("expo-sqlite/kv-store", () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { addDraft, flushDrafts, isOfflineError, memoryDraftStore, removeDraft } = await import("@/features/agents/outbox");
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
        expect((await store.read()).map((entry) => [entry.id, entry.attempts])).toEqual([["b", 1], ["c", 1]]);
        expect((await store.read()).find((entry) => entry.id === "c")?.blocked).toBe(true);
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

    it("keeps refused and unknown receipts recoverable without automatically replaying them", async () => {
        const store = memoryDraftStore([draft("refused", 1), draft("unknown", 2)]);
        let calls = 0;
        const send = async (entry: SteerDraft) => {
            calls++;
            return { ...receipt(entry.key), outcome: entry.id === "refused" ? "refused" as const : "unknown" as const };
        };
        const result = await flushDrafts({ store, connectionId: "mac-a", send });
        expect(result.sent).toEqual([]);
        expect(result.failed).toHaveLength(2);
        expect((await store.read()).every((entry) => entry.blocked && entry.lastError)).toBe(true);
        await flushDrafts({ store, connectionId: "mac-a", send });
        expect(calls).toBe(2);
        expect(await store.read()).toHaveLength(2);
    });

    it("keeps concurrent offline additions and a concurrent discard without losing another prompt", async () => {
        const store = memoryDraftStore();
        await Promise.all([addDraft(store, draft("a", 1)), addDraft(store, draft("b", 2))]);
        expect((await store.read()).map((entry) => entry.id)).toEqual(["a", "b"]);
        await Promise.all([removeDraft(store, "a"), addDraft(store, draft("c", 3))]);
        expect((await store.read()).map((entry) => entry.id)).toEqual(["b", "c"]);
    });

    it("does not resurrect a discarded draft when an in-flight replay fails", async () => {
        const store = memoryDraftStore([draft("a", 1)]);
        await flushDrafts({ store, connectionId: "mac-a", send: async (entry) => {
            await removeDraft(store, entry.id);
            throw new TypeError("Network request failed");
        } });
        expect(await store.read()).toEqual([]);
    });

    it("reports a failed store write and lets the next queued update proceed", async () => {
        const memory = memoryDraftStore();
        let fail = true;
        const store = { read: memory.read, write: async (drafts: SteerDraft[]) => {
            if (fail) {
                fail = false;
                throw new Error("store unavailable");
            }
            await memory.write(drafts);
        } };
        await expect(addDraft(store, draft("a", 1))).rejects.toThrow("store unavailable");
        await addDraft(store, draft("b", 2));
        expect((await store.read()).map((entry) => entry.id)).toEqual(["b"]);
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
