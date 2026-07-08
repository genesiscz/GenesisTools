import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { createAnnotation } from "./annotations-store";
import { addEdge, createBoard, createCard, getBoardDoc } from "./boards-store";
import { BOOTSTRAP_DDL } from "./db";
import type { BoardsDb } from "./db-types";
import { type ScrapeCard, scrapeBoard } from "./scrape";

function makeTestDb(): DatabaseClient<BoardsDb> {
    return createKyselyClient<BoardsDb>({ path: ":memory:", bootstrap: BOOTSTRAP_DDL, pragmas: { foreignKeys: true } });
}

describe("scrapeBoard", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(async () => {
        db = makeTestDb();
        await createBoard(db, { slug: "b1", title: "Board One" });
    });
    afterEach(() => db.close());

    it("digests every non-section card with per-kind text, ai flag, and embedded annotations", async () => {
        await createCard(db, "b1", { kind: "section", x: 0, y: 0, w: 600, h: 600, payload: { title: "Checkout" } });
        await createCard(db, "b1", {
            kind: "text",
            x: 50,
            y: 80,
            w: 100,
            h: 100,
            payload: { md: "hello", layer: "ai" },
        });
        await createCard(db, "b1", { kind: "note", x: 50, y: 200, w: 100, h: 100, payload: { text: "a sticky" } });
        const shot = await createCard(db, "b1", {
            kind: "shot",
            x: 50,
            y: 320,
            w: 100,
            h: 100,
            filePath: "home.png",
            blobKey: "hash1",
            payload: {},
        });
        await createAnnotation(db, {
            boardSlug: "b1",
            cardId: shot.id,
            region: { x: 0, y: 0, w: 1, h: 1 },
            intent: "fix",
            prompt: "tighten spacing",
            status: "open",
        });

        const doc = await getBoardDoc(db, "b1");
        const res = scrapeBoard({ doc, base: "http://x" });
        expect(res.ok).toBe(true);
        if (!res.ok) {
            return;
        }
        expect(res.body.board).toEqual({ slug: "b1", title: "Board One" });
        expect((res.body.sections as unknown[]).length).toBe(1);
        const cards = res.body.cards as ScrapeCard[];
        expect(cards.some((c) => c.kind === "section")).toBe(false); // frames excluded
        const text = cards.find((c) => c.kind === "text");
        expect(text?.text).toBe("hello");
        expect(text?.ai).toBe(true);
        expect(text?.section).toBe("Checkout");
        expect(cards.find((c) => c.kind === "note")?.text).toBe("a sticky");
        const shotCard = cards.find((c) => c.kind === "shot");
        expect(shotCard?.image).toBe("http://x/api/boards/blobs/hash1");
        expect(shotCard?.annotations?.[0]).toMatchObject({ intent: "fix", status: "open", prompt: "tighten spacing" });
    });

    it("walks edges into ordered flow chains; isolated cards become their own chain", async () => {
        const a = await createCard(db, "b1", { kind: "text", x: 0, y: 0, w: 50, h: 50, payload: { md: "A" } });
        const b = await createCard(db, "b1", { kind: "text", x: 0, y: 100, w: 50, h: 50, payload: { md: "B" } });
        const c = await createCard(db, "b1", { kind: "text", x: 0, y: 200, w: 50, h: 50, payload: { md: "C" } });
        const d = await createCard(db, "b1", { kind: "text", x: 0, y: 300, w: 50, h: 50, payload: { md: "D" } });
        await addEdge(db, "b1", { fromCard: a.id, toCard: b.id });
        await addEdge(db, "b1", { fromCard: b.id, toCard: c.id });
        await addEdge(db, "b1", { fromCard: a.id, toX: 500, toY: 500 }); // point-anchored → not a step

        const doc = await getBoardDoc(db, "b1");
        const res = scrapeBoard({ doc });
        expect(res.ok).toBe(true);
        if (!res.ok) {
            return;
        }
        expect(res.body.flow).toEqual([[a.id, b.id, c.id], [d.id]]);
    });

    it("?section narrows the digest and 404s an unknown section", async () => {
        await createCard(db, "b1", { kind: "section", x: 0, y: 0, w: 300, h: 300, payload: { title: "A" } });
        await createCard(db, "b1", { kind: "section", x: 400, y: 0, w: 300, h: 300, payload: { title: "B" } });
        await createCard(db, "b1", { kind: "text", x: 50, y: 80, w: 50, h: 50, payload: { md: "in-a" } });
        await createCard(db, "b1", { kind: "text", x: 450, y: 80, w: 50, h: 50, payload: { md: "in-b" } });

        const doc = await getBoardDoc(db, "b1");
        const scoped = scrapeBoard({ doc, section: "A" });
        expect(scoped.ok).toBe(true);
        if (scoped.ok) {
            expect((scoped.body.cards as ScrapeCard[]).map((c) => c.text)).toEqual(["in-a"]);
        }
        expect(scrapeBoard({ doc, section: "nope" })).toMatchObject({ ok: false, status: 404 });
        expect(scrapeBoard({ doc, section: "A", diff: "A,B" })).toMatchObject({ ok: false, status: 400 });
    });

    it("?diff pairs two sections' members by file basename", async () => {
        await createCard(db, "b1", { kind: "section", x: 0, y: 0, w: 300, h: 300, payload: { title: "V1" } });
        await createCard(db, "b1", { kind: "section", x: 400, y: 0, w: 300, h: 300, payload: { title: "V2" } });
        await createCard(db, "b1", {
            kind: "shot",
            x: 50,
            y: 80,
            w: 50,
            h: 50,
            filePath: "home.png",
            blobKey: "h1",
            payload: {},
        });
        await createCard(db, "b1", {
            kind: "shot",
            x: 450,
            y: 80,
            w: 50,
            h: 50,
            filePath: "home.png",
            blobKey: "h2",
            payload: {},
        });

        const doc = await getBoardDoc(db, "b1");
        const res = scrapeBoard({ doc, diff: "V1,V2" });
        expect(res.ok).toBe(true);
        if (!res.ok) {
            return;
        }
        expect(res.body.a).toMatchObject({ name: "V1", cards: 1 });
        expect(res.body.b).toMatchObject({ name: "V2", cards: 1 });
        const pairs = res.body.pairs as Array<{ a?: ScrapeCard; b?: ScrapeCard }>;
        expect(pairs).toHaveLength(1);
        expect(pairs[0].a?.image).toContain("h1");
        expect(pairs[0].b?.image).toContain("h2");
    });
});
