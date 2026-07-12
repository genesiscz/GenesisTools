import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { createBoard, createCard, getBoardDoc } from "./boards-store";
import type { ArrangeMode } from "./compose-types";
import { BOOTSTRAP_DDL } from "./db";
import type { BoardsDb } from "./db-types";
import {
    __resetLayoutDebounce,
    arrangeMoves,
    type CardRect,
    readingOrder,
    reflowBoard,
    runArrange,
    spacingToken,
} from "./layout-engine";

function rect(id: number, x: number, y: number, opts: Partial<CardRect> = {}): CardRect {
    return { id, kind: "text", x, y, w: 100, h: 100, payload: {}, ...opts };
}

function need<T>(v: T | undefined): T {
    if (v === undefined) {
        throw new Error("expected a defined value");
    }

    return v;
}

const ORIGIN = { x: 0, y: 0 };
function pos(cards: CardRect[], mode: ArrangeMode, extra: Record<string, unknown> = {}) {
    return arrangeMoves(cards, { mode, gap: 24, origin: ORIGIN, ...extra }).map((m) => [m.id, m.x, m.y]);
}

describe("readingOrder", () => {
    it("bands y into 16px rows so a small y-jitter doesn't reorder a row (x wins within a band)", () => {
        const A = rect(1, 400, 96);
        const B = rect(2, 100, 100); // same 16px band, to the left → reads first
        expect(readingOrder([A, B]).map((c) => c.id)).toEqual([2, 1]);
    });
});

describe("spacingToken", () => {
    it("maps S/M/L and clamps px to 0-400", () => {
        expect(spacingToken(undefined, 24)).toBe(24);
        expect(spacingToken("S", 24)).toBe(12);
        expect(spacingToken("L", 24)).toBe(48);
        expect(spacingToken(40, 24)).toBe(40);
        expect(spacingToken(401, 24)).toBeNull();
        expect(spacingToken("XL", 24)).toBeNull();
    });
});

describe("arrangeMoves — per mode", () => {
    const A = rect(1, 0, 0);
    const B = rect(2, 0, 200);
    const C = rect(3, 0, 400);

    it("column stacks vertically", () => {
        expect(pos([A, B], "column")).toEqual([
            [1, 0, 0],
            [2, 0, 124],
        ]);
    });

    it("row lays out horizontally", () => {
        expect(pos([A, B], "row")).toEqual([
            [1, 0, 0],
            [2, 124, 0],
        ]);
    });

    it("grid wraps at cols", () => {
        expect(pos([A, B, C], "grid", { cols: 2 })).toEqual([
            [1, 0, 0],
            [2, 124, 0],
            [3, 0, 124],
        ]);
    });

    it("flow wraps at wrapW", () => {
        expect(pos([A, B, C], "flow", { wrapW: 250 })).toEqual([
            [1, 0, 0],
            [2, 124, 0],
            [3, 0, 124],
        ]);
    });

    it("align-left snaps x to the min, align-top snaps y", () => {
        const cards = [rect(1, 300, 10), rect(2, 50, 60)];
        expect(arrangeMoves(cards, { mode: "align-left", gap: 24, origin: ORIGIN }).map((m) => m.x)).toEqual([0, 0]);
        expect(arrangeMoves(cards, { mode: "align-top", gap: 24, origin: ORIGIN }).map((m) => m.y)).toEqual([0, 0]);
    });

    it("distribute-h/v pack along one axis in sorted order", () => {
        const cards = [rect(2, 300, 5), rect(1, 50, 5)];
        expect(pos(cards, "distribute-h")).toEqual([
            [1, 0, 5],
            [2, 124, 5],
        ]);
    });

    it("timeline lays out in creation order", () => {
        const cards = [
            rect(2, 0, 0, { createdAt: "2026-07-08T00:00:02Z" }),
            rect(1, 0, 0, { createdAt: "2026-07-08T00:00:01Z" }),
        ];
        expect(pos(cards, "timeline")).toEqual([
            [1, 0, 0],
            [2, 124, 0],
        ]);
    });

    it("timeaxis with two equal timestamps keeps cards from overlapping", () => {
        const ts = "2026-07-08T00:00:00Z";
        const cards = [rect(1, 0, 0, { createdAt: ts }), rect(2, 0, 0, { createdAt: ts })];
        const moves = arrangeMoves(cards, { mode: "timeaxis", gap: 24, origin: ORIGIN, wrapW: 1000 });
        expect(moves[1].x).toBeGreaterThanOrEqual(moves[0].x + 100);
    });

    it("lanes groups by payload.lane, unlabeled last", () => {
        const cards = [
            rect(1, 0, 0, { payload: { lane: "happy" }, createdAt: "2026-07-08T00:00:01Z" }),
            rect(2, 0, 0, { payload: {}, createdAt: "2026-07-08T00:00:02Z" }),
            rect(3, 0, 0, { payload: { lane: "happy" }, createdAt: "2026-07-08T00:00:03Z" }),
        ];
        const moves = arrangeMoves(cards, { mode: "lanes", gap: 24, origin: ORIGIN });
        const byId = new Map(moves.map((m) => [m.id, m]));
        // lane "happy" (cards 1,3) on the top row; unlabeled (card 2) on a lower row.
        expect(byId.get(1)?.y).toBe(byId.get(3)?.y);
        expect((byId.get(2)?.y ?? 0) > (byId.get(1)?.y ?? 0)).toBe(true);
    });

    it("masonry drops each card into the shortest column and is a fixed point under reflow", () => {
        const cards = [
            rect(1, 0, 0, { h: 100, createdAt: "2026-07-08T00:00:01Z" }),
            rect(2, 0, 0, { h: 50, createdAt: "2026-07-08T00:00:02Z" }),
            rect(3, 0, 0, { h: 100, createdAt: "2026-07-08T00:00:03Z" }),
        ];
        const opts = { mode: "masonry" as ArrangeMode, gap: 24, origin: ORIGIN, cols: 2 };
        const first = arrangeMoves(cards, opts);
        expect(first.map((m) => [m.id, m.x, m.y])).toEqual([
            [1, 0, 0],
            [2, 124, 0],
            [3, 124, 74],
        ]);
        // Apply the moves, re-run: creation-order packing means identical positions (stable reflow).
        const applied = cards.map((c) => {
            const m = first.find((mm) => mm.id === c.id);
            return m ? { ...c, x: m.x, y: m.y } : c;
        });
        expect(arrangeMoves(applied, opts)).toEqual(first);
    });
});

describe("reflowBoard (saved-layout auto-reflow)", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(() => {
        db = createKyselyClient<BoardsDb>({
            path: ":memory:",
            bootstrap: BOOTSTRAP_DDL,
            pragmas: { foreignKeys: true },
        });
    });
    afterEach(() => {
        __resetLayoutDebounce();
        db.close();
    });

    it("positions a section's members per its saved column layout at the frame inner origin", async () => {
        await createBoard(db, { slug: "b1" });
        await createCard(db, "b1", {
            kind: "section",
            x: 0,
            y: 0,
            w: 400,
            h: 400,
            payload: { title: "S", layout: { mode: "column", gap: "M" } },
        });
        // Two members placed messily inside the frame.
        await createCard(db, "b1", { kind: "note", x: 200, y: 300, w: 100, h: 100, payload: { text: "1" } });
        await createCard(db, "b1", { kind: "note", x: 50, y: 100, w: 100, h: 100, payload: { text: "2" } });

        await reflowBoard(db, "b1");

        const doc = await getBoardDoc(db, "b1");
        const notes = doc.cards.filter((c) => c.kind === "note").sort((a, b) => a.y - b.y);
        // column-stacked at origin {pad:24, max(pad,titleHeadroom 56):56}, gap M(24).
        expect(notes.map((n) => [n.x, n.y])).toEqual([
            [24, 56],
            [24, 180],
        ]);
    });
});

describe("runArrange — section-aware broad scope (composite units)", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(() => {
        db = createKyselyClient<BoardsDb>({
            path: ":memory:",
            bootstrap: BOOTSTRAP_DDL,
            pragmas: { foreignKeys: true },
        });
    });
    afterEach(() => {
        __resetLayoutDebounce();
        db.close();
    });

    it("scope:all grid moves each section as one unit, keeping members inside their frame", async () => {
        await createBoard(db, { slug: "b1" });
        const sec = await createCard(db, "b1", { kind: "section", x: 0, y: 0, w: 400, h: 400, payload: { title: "S" } });
        // Two members whose centers sit inside the frame.
        const m1 = await createCard(db, "b1", { kind: "note", x: 40, y: 80, w: 100, h: 100 });
        const m2 = await createCard(db, "b1", { kind: "note", x: 200, y: 250, w: 100, h: 100 });
        // Two loose cards outside any section.
        const l1 = await createCard(db, "b1", { kind: "note", x: 900, y: 0, w: 100, h: 100 });
        const l2 = await createCard(db, "b1", { kind: "note", x: 900, y: 300, w: 100, h: 100 });

        const before = await getBoardDoc(db, "b1");
        const secBefore = need(before.cards.find((c) => c.id === sec.id));

        const outcome = await runArrange(db, "b1", { mode: "grid", scope: "all", gap: "M", cols: 3 });
        expect(outcome.ok).toBe(true);

        const after = await getBoardDoc(db, "b1");
        const byId = new Map(after.cards.map((c) => [c.id, c]));
        const secA = need(byId.get(sec.id));
        const m1A = need(byId.get(m1.id));
        const m2A = need(byId.get(m2.id));

        // Both members' centers still fall inside the (moved) frame.
        for (const m of [m1A, m2A]) {
            const cx = m.x + m.w / 2;
            const cy = m.y + m.h / 2;
            expect(cx).toBeGreaterThanOrEqual(secA.x);
            expect(cx).toBeLessThanOrEqual(secA.x + secA.w);
            expect(cy).toBeGreaterThanOrEqual(secA.y);
            expect(cy).toBeLessThanOrEqual(secA.y + secA.h);
        }
        // Relative frame→member offsets preserved exactly (frame + members moved by the same delta).
        expect(m1A.x - secA.x).toBe(m1.x - secBefore.x);
        expect(m1A.y - secA.y).toBe(m1.y - secBefore.y);
        expect(m2A.x - secA.x).toBe(m2.x - secBefore.x);
        expect(m2A.y - secA.y).toBe(m2.y - secBefore.y);
        // Loose cards still exist and were repositioned as their own units (not left null).
        expect(byId.get(l1.id)).toBeDefined();
        expect(byId.get(l2.id)).toBeDefined();
    });
});

describe("displaceSections (bug 7 — section-over-section shifts DOWN, not a wild jump)", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(() => {
        db = createKyselyClient<BoardsDb>({
            path: ":memory:",
            bootstrap: BOOTSTRAP_DDL,
            pragmas: { foreignKeys: true },
        });
    });
    afterEach(() => {
        __resetLayoutDebounce();
        db.close();
    });

    async function section(slug: string, title: string, x: number, y: number, w: number, h: number) {
        return createCard(db, slug, { kind: "section", x, y, w, h, payload: { title } });
    }

    it("pushes the later-reading overlapping section below the earlier one by exactly +80 gutter, carrying its members", async () => {
        await createBoard(db, { slug: "b1" });
        // A on top (y=0..400). B overlaps it (y=300..700) and reads later.
        const a = await section("b1", "A", 0, 0, 400, 400);
        const b = await section("b1", "B", 0, 300, 400, 400);
        // Member whose CENTER (150,550) sits inside B only (below A's bottom of 400).
        const member = await createCard(db, "b1", { kind: "note", x: 100, y: 500, w: 100, h: 100 });

        await reflowBoard(db, "b1");

        const doc = await getBoardDoc(db, "b1");
        const byId = new Map(doc.cards.map((c) => [c.id, c]));
        // A unchanged.
        expect([byId.get(a.id)?.x, byId.get(a.id)?.y]).toEqual([0, 0]);
        // B pushed to just below A + 80 gutter: 400 + 80 = 480. dy = 180.
        expect(byId.get(b.id)?.y).toBe(480);
        // Member carried by the same dy (500 → 680).
        expect(byId.get(member.id)?.y).toBe(680);
        // Grow-only: frame heights are never shrunk.
        expect(byId.get(a.id)?.h).toBe(400);
        expect(byId.get(b.id)?.h).toBe(400);
    });

    it("resolves a 3-section overlap cascade so no two frames overlap (bounded 4-iteration)", async () => {
        await createBoard(db, { slug: "b1" });
        await section("b1", "A", 0, 0, 400, 300);
        await section("b1", "B", 0, 100, 400, 300);
        await section("b1", "C", 0, 200, 400, 300);

        await reflowBoard(db, "b1");

        const doc = await getBoardDoc(db, "b1");
        const frames = doc.cards.filter((c) => c.kind === "section").sort((p, q) => p.y - q.y);
        // Every consecutive pair is separated (later frame starts at or below the earlier's bottom).
        for (let i = 1; i < frames.length; i += 1) {
            expect(frames[i].y).toBeGreaterThanOrEqual(frames[i - 1].y + frames[i - 1].h);
        }
    });

    it("leaves non-overlapping sections untouched (no spurious moves)", async () => {
        await createBoard(db, { slug: "b1" });
        const a = await section("b1", "A", 0, 0, 400, 300);
        const b = await section("b1", "B", 0, 500, 400, 300); // clear of A (A bottom 300 < 500)

        const moves = await reflowBoard(db, "b1");
        expect(moves).toEqual([]);

        const doc = await getBoardDoc(db, "b1");
        const byId = new Map(doc.cards.map((c) => [c.id, c]));
        expect(byId.get(a.id)?.y).toBe(0);
        expect(byId.get(b.id)?.y).toBe(500);
    });
});
