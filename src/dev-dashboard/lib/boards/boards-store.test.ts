import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { env } from "@app/utils/env";
import {
    addEdge,
    addStrokes,
    appendCardVersion,
    bulkLayout,
    createBoard,
    createCard,
    getBoardBySlug,
    getBoardDoc,
    importSet,
    listBoards,
    listCardVersions,
    listTrash,
    patchBoard,
    patchCard,
    restoreCard,
    revertCardFace,
    SlugConflictError,
    softDeleteCard,
} from "./boards-store";
import { BOOTSTRAP_DDL } from "./db";
import type { BoardsDb } from "./db-types";
import { getSet, NotFoundError, syncSet } from "./sets-store";

function makeTestDb(): DatabaseClient<BoardsDb> {
    return createKyselyClient<BoardsDb>({ path: ":memory:", bootstrap: BOOTSTRAP_DDL, pragmas: { foreignKeys: true } });
}

function u32be(n: number): number[] {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function buildPng(width: number, height: number): Uint8Array {
    return new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52,
        ...u32be(width),
        ...u32be(height),
        0x08,
        0x06,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
    ]);
}

function pngFile(path: string, width: number, height: number) {
    return { path, data: buildPng(width, height) };
}

describe("boards-store", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(() => {
        const dir = mkdtempSync(join(tmpdir(), "boards-store-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
    });

    it("creates, lists, gets, and patches a board", async () => {
        const created = await createBoard(db, { slug: "my-board", title: "My Board" });
        expect(created.slug).toBe("my-board");
        expect(created.archived).toBe(false);

        const fetched = await getBoardBySlug(db, "my-board");
        expect(fetched.id).toBe(created.id);

        const list = await listBoards(db);
        expect(list.length).toBe(1);
        expect(list[0].cardCount).toBe(0);
        expect(list[0].openWork).toBe(0);

        const patched = await patchBoard(db, "my-board", { title: "Renamed", archived: true });
        expect(patched.title).toBe("Renamed");
        expect(patched.archived).toBe(true);
    });

    it("rejects uppercase slugs, reserved slugs, and duplicate slugs", async () => {
        await expect(createBoard(db, { slug: "MyBoard" })).rejects.toBeInstanceOf(SlugConflictError);
        await expect(createBoard(db, { slug: "sets" })).rejects.toBeInstanceOf(SlugConflictError);
        await createBoard(db, { slug: "dup" });
        await expect(createBoard(db, { slug: "dup" })).rejects.toBeInstanceOf(SlugConflictError);
    });

    it("getBoardBySlug throws NotFoundError for an unknown slug", async () => {
        await expect(getBoardBySlug(db, "nope")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("assigns sequential elemNo per board and seeds card_versions v1 for cards with a blob", async () => {
        await createBoard(db, { slug: "b1" });
        const c1 = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100 });
        const c2 = await createCard(db, "b1", { kind: "note", x: 10, y: 10, w: 100, h: 100 });
        const c3 = await createCard(db, "b1", {
            kind: "shot",
            x: 20,
            y: 20,
            w: 100,
            h: 100,
            blobKey: "deadbeef.png",
            filePath: "a.png",
        });
        expect(c1.elemNo).toBe(1);
        expect(c2.elemNo).toBe(2);
        expect(c3.elemNo).toBe(3);
        expect(c3.currentVersion).toBe(1);

        const versions = await listCardVersions(db, c3.id);
        expect(versions.length).toBe(1);
        expect(versions[0].version).toBe(1);
        expect(versions[0].blobKey).toBe("deadbeef.png");

        // note cards never touched a blob — no history row seeded.
        expect((await listCardVersions(db, c1.id)).length).toBe(0);
    });

    it("soft delete excludes a card from getBoardDoc, lists it in trash, and restore brings it back", async () => {
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100 });

        await softDeleteCard(db, card.id);
        expect((await getBoardDoc(db, "b1")).cards.map((c) => c.id)).not.toContain(card.id);
        const trashed = await listTrash(db, "b1");
        expect(trashed.map((c) => c.id)).toContain(card.id);

        const restored = await restoreCard(db, card.id);
        expect(restored.id).toBe(card.id);
        expect((await getBoardDoc(db, "b1")).cards.map((c) => c.id)).toContain(card.id);
        expect((await listTrash(db, "b1")).length).toBe(0);
    });

    it("patchCard updates position/size and payload", async () => {
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100 });
        const patched = await patchCard(db, card.id, { x: 50, payload: { text: "hi" } });
        expect(patched.x).toBe(50);
        expect(patched.y).toBe(0);
        expect(patched.payload).toEqual({ text: "hi" });
    });

    it("bulkLayout moves multiple cards in one call and rejects out-of-range batches", async () => {
        await createBoard(db, { slug: "b1" });
        const c1 = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100 });
        const c2 = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100 });

        await bulkLayout(db, "b1", [
            { id: c1.id, x: 111, y: 222 },
            { id: c2.id, x: 333, y: 444 },
        ]);
        const doc = await getBoardDoc(db, "b1");
        const moved1 = doc.cards.find((c) => c.id === c1.id);
        const moved2 = doc.cards.find((c) => c.id === c2.id);
        expect(moved1?.x).toBe(111);
        expect(moved1?.y).toBe(222);
        expect(moved2?.x).toBe(333);
        expect(moved2?.y).toBe(444);

        const tooMany = Array.from({ length: 501 }, (_, i) => ({ id: c1.id, x: i, y: i }));
        await expect(bulkLayout(db, "b1", tooMany)).rejects.toThrow();
        await expect(bulkLayout(db, "b1", [])).rejects.toThrow();
    });

    it("addStrokes and addEdge attach to a board and appear in getBoardDoc", async () => {
        await createBoard(db, { slug: "b1" });
        const c1 = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100 });
        const c2 = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100 });

        const strokes = await addStrokes(db, "b1", [{ path: [[1, 2, 0.5]] }]);
        expect(strokes.length).toBe(1);
        expect(strokes[0].cardId).toBeNull();

        const edge = await addEdge(db, "b1", { fromCard: c1.id, toCard: c2.id, label: "next" });
        expect(edge.fromCard).toBe(c1.id);
        expect(edge.toCard).toBe(c2.id);

        const doc = await getBoardDoc(db, "b1");
        expect(doc.strokes.length).toBe(1);
        expect(doc.edges.length).toBe(1);
    });

    it("importSet lays out cards in a serpentine grid, dedupes on re-import, and links edges", async () => {
        await createBoard(db, { slug: "b1" });
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [
                pngFile("shot1.png", 420, 100),
                pngFile("shot2.png", 420, 100),
                pngFile("shot3.png", 420, 100),
                pngFile("shot4.png", 420, 100),
                pngFile("shot5.png", 420, 100),
            ],
        });
        const detail = await getSet(db, "proj", "main", "s1");

        const first = await importSet(db, "b1", detail);
        expect(first.cards.length).toBe(5);
        expect(first.skipped).toBe(0);
        expect(first.edges.length).toBe(4);

        // serpentine: card index 3 (4th card) is row 0 col 3; index 4 (5th card) is row 1 col 3 (reversed).
        const cellStride = 420 + 48;
        expect(first.cards[3].x).toBe(3 * cellStride);
        expect(first.cards[3].y).toBe(0);
        expect(first.cards[4].x).toBe(3 * cellStride);
        expect(first.cards[4].y).toBeGreaterThan(0);

        const second = await importSet(db, "b1", detail);
        expect(second.cards.length).toBe(0);
        expect(second.skipped).toBe(5);

        const doc = await getBoardDoc(db, "b1");
        expect(doc.cards.length).toBe(5);
    });

    it("appendCardVersion + revertCardFace round-trip: face swaps then reverts, history keeps both rows", async () => {
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", {
            kind: "shot",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            setRef: "proj/main/s1",
            setVersion: 1,
            filePath: "a.png",
            blobKey: "hash1.png",
        });
        expect(card.currentVersion).toBe(1);

        const v2 = await appendCardVersion(db, card.id, {
            setRef: "proj/main/s1",
            setVersion: 2,
            filePath: "a.png",
            blobKey: "hash2.png",
        });
        expect(v2).toBe(2);

        const afterAppend = (await getBoardDoc(db, "b1")).cards.find((c) => c.id === card.id);
        expect(afterAppend?.blobKey).toBe("hash2.png");
        expect(afterAppend?.currentVersion).toBe(2);

        const reverted = await revertCardFace(db, card.id, 1);
        expect(reverted.blobKey).toBe("hash1.png");
        expect(reverted.currentVersion).toBe(1);

        const versions = await listCardVersions(db, card.id);
        expect(versions.length).toBe(2);
        expect(versions.map((v) => v.blobKey)).toEqual(["hash1.png", "hash2.png"]);
    });
});
