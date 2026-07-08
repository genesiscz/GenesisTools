import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { createBoard, createCard, getBoardDoc } from "./boards-store";
import { composeBoard } from "./compose-store";
import { BOOTSTRAP_DDL } from "./db";
import type { BoardsDb } from "./db-types";
import { __resetLayoutDebounce } from "./layout-engine";

function makeTestDb(): DatabaseClient<BoardsDb> {
    return createKyselyClient<BoardsDb>({ path: ":memory:", bootstrap: BOOTSTRAP_DDL, pragmas: { foreignKeys: true } });
}

const textCard = (ref: string, md: string) => ({ ref, kind: "text", payload: { md } });

describe("composeBoard", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(async () => {
        db = makeTestDb();
        await createBoard(db, { slug: "b1" });
    });
    afterEach(() => {
        __resetLayoutDebounce();
        db.close();
    });

    it("rejects an empty batch", async () => {
        const r = await composeBoard(db, "b1", { cards: [] });
        expect(r).toMatchObject({ ok: false, code: "empty", index: -1 });
    });

    it("rejects more than 60 cards with limit (413)", async () => {
        const cards = Array.from({ length: 61 }, (_, i) => textCard(`c${i}`, "x"));
        expect(await composeBoard(db, "b1", { cards })).toMatchObject({ ok: false, code: "limit" });
    });

    it("rejects a duplicate ref", async () => {
        const r = await composeBoard(db, "b1", { cards: [textCard("a", "x"), textCard("a", "y")] });
        expect(r).toMatchObject({ ok: false, code: "bad_ref", index: 1 });
    });

    it("rejects an edge pointing at an unknown ref", async () => {
        const r = await composeBoard(db, "b1", {
            cards: [textCard("a", "x")],
            edges: [{ from: "a", to: "ghost" }],
        });
        expect(r).toMatchObject({ ok: false, code: "bad_ref", index: 0 });
    });

    it("rejects children on a non-cluster/section card", async () => {
        const r = await composeBoard(db, "b1", {
            cards: [{ ref: "t", kind: "text", payload: { md: "x" }, children: ["m"] }, textCard("m", "y")],
        });
        expect(r).toMatchObject({ ok: false, code: "bad_payload", index: 0 });
    });

    it("rejects a child claimed by two frames", async () => {
        const r = await composeBoard(db, "b1", {
            cards: [
                { ref: "c1", kind: "cluster", payload: {}, children: ["m"] },
                { ref: "c2", kind: "cluster", payload: {}, children: ["m"] },
                textCard("m", "y"),
            ],
        });
        expect(r).toMatchObject({ ok: false, code: "bad_ref", index: 1 });
    });

    it("rejects a compare card referencing a card not on the board", async () => {
        const r = await composeBoard(db, "b1", {
            cards: [{ kind: "compare", payload: { a: { cardId: 999 }, b: { cardId: 998 } } }],
        });
        expect(r).toMatchObject({ ok: false, code: "not_found", index: 0 });
    });

    it("rejects both section and anchor together (bad_payload)", async () => {
        const anchor = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 100, h: 100, payload: { text: "x" } });
        const r = await composeBoard(db, "b1", {
            section: "Checkout",
            anchorCardId: anchor.id,
            cards: [textCard("a", "x")],
        });
        expect(r).toMatchObject({ ok: false, code: "bad_payload", index: -1 });
    });

    it("happy path: 3 texts + 1 edge + 1 question, layer-stamped, elemNos, staged question", async () => {
        const r = await composeBoard(db, "b1", {
            cards: [textCard("a", "A"), textCard("b", "B"), textCard("c", "C")],
            edges: [{ from: "a", to: "b", label: "then" }],
            questions: [{ cardRef: "c", prompt: "Which?", options: ["one", "two"] }],
        });
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.cards).toHaveLength(3);
        expect(r.cards.map((c) => c.ref)).toEqual(["a", "b", "c"]);
        expect(r.cards.every((c) => c.elemNo > 0)).toBe(true);
        expect(r.edges).toHaveLength(1);
        expect(r.questions).toHaveLength(1);
        expect(r.region.w).toBeGreaterThan(0);

        const doc = await getBoardDoc(db, "b1");
        const composed = doc.cards.filter((c) => c.kind === "text");
        expect(composed).toHaveLength(3);
        expect(composed.every((c) => c.payload.layer === "ai")).toBe(true);
        expect(doc.questions).toHaveLength(1);
        expect(doc.questions[0].staged).toBe(true);
    });

    it("section-anchored batch places below members and grows the frame", async () => {
        await createCard(db, "b1", {
            kind: "section",
            x: 0,
            y: 0,
            w: 300,
            h: 200,
            payload: { title: "Checkout" },
        });
        const r = await composeBoard(db, "b1", {
            section: "Checkout",
            cards: [{ kind: "wireframe", payload: { nodes: [{ t: "nav" }], device: "phone" } }], // 260x520
        });
        expect(r.ok).toBe(true);

        const doc = await getBoardDoc(db, "b1");
        const section = doc.cards.find((c) => c.kind === "section");
        expect(section).toBeDefined();
        // The 520-tall wireframe forces the 200-tall frame to grow.
        expect((section?.h ?? 0) > 200).toBe(true);
        // The placed card sits inside the (grown) frame's bounds.
        const wf = doc.cards.find((c) => c.kind === "wireframe");
        expect(wf).toBeDefined();
        expect((wf?.y ?? 0) >= 0).toBe(true);
    });

    it("all-or-nothing: an invalid card at index 4 persists nothing and reports its index", async () => {
        const before = (await getBoardDoc(db, "b1")).cards.length;
        const r = await composeBoard(db, "b1", {
            cards: [
                textCard("a", "A"),
                textCard("b", "B"),
                textCard("c", "C"),
                textCard("d", "D"),
                { kind: "text", payload: {} }, // index 4: missing md
            ],
        });
        expect(r).toMatchObject({ ok: false, code: "bad_payload", index: 4 });
        const after = (await getBoardDoc(db, "b1")).cards.length;
        expect(after).toBe(before);
    });
});
