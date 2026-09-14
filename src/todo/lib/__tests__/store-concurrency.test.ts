import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoStore } from "../store";

/**
 * Agents fire N `tools todo add` calls in parallel. Before the store took a
 * file lock, every writer read the same array and the last write won: three
 * parallel adds against one project reported three ids and left ONE on disk
 * (observed 2026-09-09, handoff h_n1ddmgvx).
 *
 * How strong each case is as a detector, measured 2026-09-14 by running this
 * file against the pre-lock store (the parent of the commit that added the
 * lock), six times:
 *
 * - the file as a whole failed 6 of 6 runs;
 * - "three separate store instances", "ten-way parallel add" and "concurrent
 *   update" each failed 6 of 6, so those three are the real guard;
 * - "three adds on one store" failed 4 of 6 and "a remove races two adds"
 *   failed 3 of 6. Both are genuine races with a narrow window, so a single
 *   green run of either proves nothing on its own. They stay because they
 *   cover distinct interleavings, not because they are reliable alarms.
 *
 * Read a failure here as real and a lone pass as inconclusive; trust the file,
 * never one case.
 */
let TEST_DIR: string;
let STORAGE_ROOT: string;

function newStore(): TodoStore {
    return TodoStore.forProject(TEST_DIR, { storageRoot: STORAGE_ROOT });
}

beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), "todo-race-test-"));
    STORAGE_ROOT = join(TEST_DIR, ".storage");
});

afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("concurrent writers", () => {
    it("keeps all three todos when three adds run in parallel on one store", async () => {
        const store = newStore();

        const created = await Promise.all([
            store.add({ title: "call slot 12:00" }),
            store.add({ title: "call slot 14:00" }),
            store.add({ title: "call slot 16:00" }),
        ]);

        const createdIds = created.map((t) => t.id).sort();
        const persistedIds = (await store.list()).map((t) => t.id).sort();

        expect(createdIds).toHaveLength(3);
        expect(persistedIds).toEqual(createdIds);
    });

    it("keeps all three todos when three separate store instances add in parallel", async () => {
        const created = await Promise.all([
            newStore().add({ title: "slot a" }),
            newStore().add({ title: "slot b" }),
            newStore().add({ title: "slot c" }),
        ]);

        const createdIds = created.map((t) => t.id).sort();
        const persistedIds = (await newStore().list()).map((t) => t.id).sort();

        expect(persistedIds).toEqual(createdIds);
    });

    it("survives a ten-way parallel add", async () => {
        const store = newStore();
        const created = await Promise.all(Array.from({ length: 10 }, (_, i) => store.add({ title: `bulk ${i}` })));

        const persisted = await store.list();

        expect(persisted).toHaveLength(10);
        expect(persisted.map((t) => t.id).sort()).toEqual(created.map((t) => t.id).sort());
    });

    it("keeps every concurrent update to a different todo", async () => {
        const store = newStore();
        const a = await store.add({ title: "a" });
        const b = await store.add({ title: "b" });
        const c = await store.add({ title: "c" });

        await Promise.all([
            store.update(a.id, { status: "in-progress" }),
            store.update(b.id, { status: "blocked" }),
            store.update(c.id, { status: "done" }),
        ]);

        const byId = new Map((await store.list()).map((t) => [t.id, t]));

        expect(byId.get(a.id)?.status).toBe("in-progress");
        expect(byId.get(b.id)?.status).toBe("blocked");
        expect(byId.get(c.id)?.status).toBe("done");
    });

    it("does not lose a todo when a remove races two adds", async () => {
        const store = newStore();
        const doomed = await store.add({ title: "doomed" });

        const [, kept1, kept2] = await Promise.all([
            store.remove(doomed.id),
            store.add({ title: "kept 1" }),
            store.add({ title: "kept 2" }),
        ]);

        const persistedIds = (await store.list()).map((t) => t.id).sort();

        expect(persistedIds).toEqual([kept1.id, kept2.id].sort());
    });
});
