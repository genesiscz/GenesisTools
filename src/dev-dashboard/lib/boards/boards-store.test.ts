import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import {
    addEdge,
    addStrokes,
    answerQuestion,
    appendCardVersion,
    bulkLayout,
    createBoard,
    createCard,
    createQuestion,
    getBoardBySlug,
    getBoardDoc,
    InvalidInputError,
    importSet,
    listBoards,
    listCardVersions,
    listQuestions,
    listTrash,
    patchBoard,
    patchCard,
    patchStroke,
    restoreCard,
    revertCardFace,
    SlugConflictError,
    softDeleteCard,
    syncSetCards,
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
    let dir = "";

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "boards-store-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
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
        await expect(createBoard(db, { slug: "MyBoard" })).rejects.toBeInstanceOf(InvalidInputError);
        await expect(createBoard(db, { slug: "sets" })).rejects.toBeInstanceOf(InvalidInputError);
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

    it("patchCard moving a section carries its spatial members by the same delta", async () => {
        await createBoard(db, { slug: "b1" });
        const sec = await createCard(db, "b1", {
            kind: "section",
            x: 0,
            y: 0,
            w: 400,
            h: 400,
            payload: { title: "S" },
        });
        const m1 = await createCard(db, "b1", { kind: "note", x: 40, y: 80, w: 100, h: 100 });
        const m2 = await createCard(db, "b1", { kind: "note", x: 200, y: 250, w: 100, h: 100 });
        const outside = await createCard(db, "b1", { kind: "note", x: 900, y: 900, w: 100, h: 100 });

        await patchCard(db, sec.id, { x: 100 });

        const byId = new Map((await getBoardDoc(db, "b1")).cards.map((c) => [c.id, c]));
        expect(byId.get(sec.id)?.x).toBe(100);
        // Members translated +100 in x, y untouched.
        expect(byId.get(m1.id)?.x).toBe(140);
        expect(byId.get(m1.id)?.y).toBe(80);
        expect(byId.get(m2.id)?.x).toBe(300);
        expect(byId.get(m2.id)?.y).toBe(250);
        // A card outside the frame is not a member → untouched.
        expect(byId.get(outside.id)?.x).toBe(900);
    });

    it("patchCard resizing a section leaves its members unmoved", async () => {
        await createBoard(db, { slug: "b1" });
        const sec = await createCard(db, "b1", {
            kind: "section",
            x: 0,
            y: 0,
            w: 400,
            h: 400,
            payload: { title: "S" },
        });
        const m1 = await createCard(db, "b1", { kind: "note", x: 40, y: 80, w: 100, h: 100 });

        await patchCard(db, sec.id, { w: 600, h: 500 });

        const byId = new Map((await getBoardDoc(db, "b1")).cards.map((c) => [c.id, c]));
        expect(byId.get(sec.id)?.w).toBe(600);
        expect(byId.get(sec.id)?.h).toBe(500);
        expect(byId.get(m1.id)?.x).toBe(40);
        expect(byId.get(m1.id)?.y).toBe(80);
    });

    it("bulkLayout applies a section+member batch verbatim (no double translation)", async () => {
        await createBoard(db, { slug: "b1" });
        const sec = await createCard(db, "b1", {
            kind: "section",
            x: 0,
            y: 0,
            w: 400,
            h: 400,
            payload: { title: "S" },
        });
        const m1 = await createCard(db, "b1", { kind: "note", x: 40, y: 80, w: 100, h: 100 });

        // The UI section-drag batch already includes the member's new position.
        await bulkLayout(db, "b1", [
            { id: sec.id, x: 100, y: 0 },
            { id: m1.id, x: 140, y: 80 },
        ]);

        const byId = new Map((await getBoardDoc(db, "b1")).cards.map((c) => [c.id, c]));
        expect(byId.get(sec.id)?.x).toBe(100);
        // Exactly what was sent — not 240 (which a double-carry would produce).
        expect(byId.get(m1.id)?.x).toBe(140);
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

    it("patchStroke re-anchors the path and restyles color/width, leaving omitted fields intact", async () => {
        await createBoard(db, { slug: "b1" });
        const [stroke] = await addStrokes(db, "b1", [{ path: [[1, 2, 0.5]], color: "#e33", width: 3 }]);

        // Move: new path only — color/width unchanged.
        const moved = await patchStroke(db, stroke.id, {
            path: [
                [10, 20, 0.5],
                [30, 40, 0.5],
            ],
        });
        expect(moved.path).toEqual([
            [10, 20, 0.5],
            [30, 40, 0.5],
        ]);
        expect(moved.color).toBe("#e33");
        expect(moved.width).toBe(3);

        // Restyle: color/width only — path unchanged.
        const restyled = await patchStroke(db, stroke.id, { color: "#08f", width: 6 });
        expect(restyled.path).toEqual([
            [10, 20, 0.5],
            [30, 40, 0.5],
        ]);
        expect(restyled.color).toBe("#08f");
        expect(restyled.width).toBe(6);

        const doc = await getBoardDoc(db, "b1");
        expect(doc.strokes[0]).toMatchObject({ id: stroke.id, color: "#08f", width: 6 });
    });

    it("patchStroke rejects an empty path and 404s an unknown id", async () => {
        await createBoard(db, { slug: "b1" });
        const [stroke] = await addStrokes(db, "b1", [{ path: [[1, 2, 0.5]] }]);
        await expect(patchStroke(db, stroke.id, { path: [] })).rejects.toBeInstanceOf(InvalidInputError);
        await expect(patchStroke(db, 999, { color: "#000" })).rejects.toBeInstanceOf(NotFoundError);
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

    it("importSet persists each card's source-image dims in payload.naturalWidth/Height, even when downscaled to the fixed import cell width", async () => {
        await createBoard(db, { slug: "b1" });
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            // A source screenshot much wider than IMPORT_CELL_W (420) — the card is downscaled to fit.
            entries: [pngFile("shot1.png", 1290, 2796)],
        });
        const detail = await getSet(db, "proj", "main", "s1");

        const { cards } = await importSet(db, "b1", detail);
        expect(cards[0].w).toBe(420); // downscaled display width (IMPORT_CELL_W)
        expect(cards[0].payload.naturalWidth).toBe(1290); // source-image width preserved
        expect(cards[0].payload.naturalHeight).toBe(2796);
    });

    it("syncSetCards re-points cards to a newer key under the same project/branch, refreshing dims and preserving other payload keys", async () => {
        await createBoard(db, { slug: "b1" });
        // Push K1 (version 1) and import it — the card lands tagged with set_ref proj/main/s1.
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [pngFile("a.png", 1170, 2532)],
        });
        const set1 = await getSet(db, "proj", "main", "s1");
        const { cards } = await importSet(db, "b1", set1);
        const cardId = cards[0].id;
        expect(cards[0].setRef).toBe("proj/main/s1");

        // Annotate an unrelated payload key to prove the remap preserves it.
        const before = await getBoardDoc(db, "b1");
        const priorPayload = before.cards.find((c) => c.id === cardId)?.payload ?? {};
        await patchCard(db, cardId, { payload: { ...priorPayload, note: "keep me" } });

        // Push K2 — a NEW key under the SAME (proj, main). The version counter is shared per
        // (project, branch), so K2 mints version 2, which strands K1's card at version 1. Same
        // file path (so path-match remap fires) but different content (so the blob key changes).
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s2",
            entries: [pngFile("a.png", 1290, 2796)],
        });
        const set2 = await getSet(db, "proj", "main", "s2"); // latest === K2
        expect(set2.version).toBe(2);

        const result = await syncSetCards(db, "b1", set2);
        expect(result.updated).toBe(1);

        const doc = await getBoardDoc(db, "b1");
        const updated = doc.cards.find((c) => c.id === cardId);
        expect(updated?.setRef).toBe("proj/main/s2"); // re-pointed onto the newer key
        expect(updated?.blobKey).toBe(set2.files[0].blobKey);
        expect(updated?.blobKey).not.toBe(set1.files[0].blobKey); // genuinely a new blob
        expect(updated?.payload.naturalWidth).toBe(1290);
        expect(updated?.payload.naturalHeight).toBe(2796);
        expect(updated?.payload.note).toBe("keep me"); // unrelated payload key untouched
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

    it("appendCardVersion after a revert mints a fresh version number instead of colliding with history", async () => {
        // Regression: nextVersion must come from MAX(card_versions.version), not
        // board_cards.current_version — after a revert moves current_version backward,
        // current_version+1 would re-collide with a version number already in history.
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

        const v2 = await appendCardVersion(db, card.id, {
            setRef: "proj/main/s1",
            setVersion: 2,
            filePath: "a.png",
            blobKey: "hash2.png",
        });
        expect(v2).toBe(2);
        await revertCardFace(db, card.id, 1);

        const v3 = await appendCardVersion(db, card.id, {
            setRef: "proj/main/s1",
            setVersion: 3,
            filePath: "a.png",
            blobKey: "hash3.png",
        });
        expect(v3).toBe(3);

        const versions = await listCardVersions(db, card.id);
        expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
        expect(versions.map((v) => v.blobKey)).toEqual(["hash1.png", "hash2.png", "hash3.png"]);
    });

    it("createQuestion inserts staged/undelivered with a null cardId for board-level questions", async () => {
        await createBoard(db, { slug: "b1" });
        const q = await createQuestion(db, "b1", {
            cardId: 0,
            prompt: "pick one",
            options: [{ label: "a" }, { label: "b" }],
            multi: false,
        });
        expect(q).toMatchObject({
            cardId: null,
            prompt: "pick one",
            options: [{ label: "a" }, { label: "b" }],
            answer: null,
            answeredBy: "",
            staged: true,
            multi: false,
        });
    });

    it("createQuestion rejects a cardId that isn't a live card on this board", async () => {
        await createBoard(db, { slug: "b1" });
        await expect(
            createQuestion(db, "b1", { cardId: 999, prompt: "pick one", options: [{ label: "a" }], multi: false })
        ).rejects.toThrow(NotFoundError);
    });

    it("listQuestions returns a board's questions oldest-first", async () => {
        await createBoard(db, { slug: "b1" });
        const q1 = await createQuestion(db, "b1", { cardId: 0, prompt: "first", options: [{ label: "a" }] });
        const q2 = await createQuestion(db, "b1", { cardId: 0, prompt: "second", options: [{ label: "a" }] });
        const list = await listQuestions(db, "b1");
        expect(list.map((q) => q.id)).toEqual([q1.id, q2.id]);
    });

    it("answerQuestion wraps a single-select answer as a one-element JSON array", async () => {
        await createBoard(db, { slug: "b1" });
        const q = await createQuestion(db, "b1", { cardId: 0, prompt: "pick one", options: [{ label: "picked" }] });
        const answered = await answerQuestion(db, q.id, "picked", "user");
        expect(answered.answer).toEqual(["picked"]);
        expect(answered.answeredBy).toBe("user");
        expect(answered.staged).toBe(true); // still staged — dispatch releases it, not the answer itself
    });

    it("answerQuestion stores a multi-select answer's pre-encoded JSON array as-is", async () => {
        await createBoard(db, { slug: "b1" });
        const q = await createQuestion(db, "b1", {
            cardId: 0,
            prompt: "pick some",
            options: [{ label: "a" }, { label: "b" }],
            multi: true,
        });
        const answered = await answerQuestion(db, q.id, SafeJSON.stringify(["a", "b"]), "user");
        expect(answered.answer).toEqual(["a", "b"]);
    });

    it("answerQuestion on an unknown id throws NotFoundError", async () => {
        await expect(answerQuestion(db, 999, "picked", "user")).rejects.toThrow(NotFoundError);
    });

    it("answerQuestion overwrites a prior answer while the question is still staged (re-picks are free)", async () => {
        await createBoard(db, { slug: "b1" });
        const q = await createQuestion(db, "b1", {
            cardId: 0,
            prompt: "pick one",
            options: [{ label: "a" }, { label: "b" }],
        });
        const first = await answerQuestion(db, q.id, "a", "user");
        expect(first.answer).toEqual(["a"]);
        const second = await answerQuestion(db, q.id, "b", "user");
        expect(second.answer).toEqual(["b"]); // last pick wins
        expect(second.staged).toBe(true);
    });

    it("answerQuestion rejects a re-answer once the question has been dispatched (staged=0, answer locked)", async () => {
        await createBoard(db, { slug: "b1" });
        const q = await createQuestion(db, "b1", { cardId: 0, prompt: "pick one", options: [{ label: "a" }] });
        await answerQuestion(db, q.id, "a", "user");
        // Simulate dispatch releasing the answer onto the work wire.
        await db.kysely.updateTable("board_questions").set({ staged: 0 }).where("id", "=", q.id).execute();
        await expect(answerQuestion(db, q.id, "a", "user")).rejects.toBeInstanceOf(InvalidInputError);
    });
});
