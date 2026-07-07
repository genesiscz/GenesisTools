import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import { createAnnotation, patchAnnotation } from "./annotations-store";
import { createBoard, createCard } from "./boards-store";
import { BOOTSTRAP_DDL } from "./db";
import type { BoardsDb } from "./db-types";
import { resetEventHub } from "./events";
import type { Region } from "./types";
import {
    claimOrRenewLease,
    dispatchBoard,
    drainChoices,
    listenerTtlMs,
    listListeners,
    listWork,
    reapExpiredListeners,
    releaseLease,
} from "./work-store";

function makeTestDb(): DatabaseClient<BoardsDb> {
    return createKyselyClient<BoardsDb>({ path: ":memory:", bootstrap: BOOTSTRAP_DDL, pragmas: { foreignKeys: true } });
}

const REGION: Region = { x: 0, y: 0, w: 1, h: 1 };

async function makeCard(db: DatabaseClient<BoardsDb>, boardSlug: string, setRef: string) {
    return createCard(db, boardSlug, {
        kind: "shot",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        setRef,
        setVersion: 1,
        filePath: "a.png",
        blobKey: "h.png",
    });
}

describe("work-store", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(() => {
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
        resetEventHub();
    });

    it("listWork isolates by board scope and defaults to status=open (staged never appears)", async () => {
        await createBoard(db, { slug: "board-a" });
        await createBoard(db, { slug: "board-b" });
        const cardA = await makeCard(db, "board-a", "proj/main/s1");
        const cardB = await makeCard(db, "board-b", "proj/main/s1");

        await createAnnotation(db, {
            boardSlug: "board-a",
            cardId: cardA.id,
            region: REGION,
            intent: "fix",
            prompt: "a-open",
            status: "open",
        });
        await createAnnotation(db, {
            boardSlug: "board-a",
            cardId: cardA.id,
            region: REGION,
            intent: "fix",
            prompt: "a-staged",
            status: "staged",
        });
        await createAnnotation(db, {
            boardSlug: "board-b",
            cardId: cardB.id,
            region: REGION,
            intent: "fix",
            prompt: "b-open",
            status: "open",
        });

        const allOpen = await listWork(db, {});
        expect(allOpen.map((w) => w.prompt).sort()).toEqual(["a-open", "b-open"]);

        const boardAOnly = await listWork(db, { board: "board-a" });
        expect(boardAOnly.map((w) => w.prompt)).toEqual(["a-open"]);
    });

    it("project/branch scope matches the card's set_ref prefix", async () => {
        await createBoard(db, { slug: "b1" });
        const cardMain = await makeCard(db, "b1", "proj/main/s1");
        const cardFeature = await makeCard(db, "b1", "proj/feature-x/s1");
        const cardOtherProject = await makeCard(db, "b1", "other/main/s1");

        await createAnnotation(db, {
            boardSlug: "b1",
            cardId: cardMain.id,
            region: REGION,
            intent: "fix",
            prompt: "main",
            status: "open",
        });
        await createAnnotation(db, {
            boardSlug: "b1",
            cardId: cardFeature.id,
            region: REGION,
            intent: "fix",
            prompt: "feature",
            status: "open",
        });
        await createAnnotation(db, {
            boardSlug: "b1",
            cardId: cardOtherProject.id,
            region: REGION,
            intent: "fix",
            prompt: "other",
            status: "open",
        });

        const projectOnly = await listWork(db, { project: "proj" });
        expect(projectOnly.map((w) => w.prompt).sort()).toEqual(["feature", "main"]);

        const narrowed = await listWork(db, { project: "proj", branch: "main" });
        expect(narrowed.map((w) => w.prompt)).toEqual(["main"]);
    });

    it("dispatchBoard flips staged annotations to open and releases answered staged questions", async () => {
        await createBoard(db, { slug: "b1" });
        const card = await makeCard(db, "b1", "proj/main/s1");
        const staged = await createAnnotation(db, {
            boardSlug: "b1",
            cardId: card.id,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "staged",
        });

        const board = await db.kysely
            .selectFrom("boards")
            .selectAll()
            .where("slug", "=", "b1")
            .executeTakeFirstOrThrow();
        const now = new Date().toISOString();
        const answeredQuestion = await db.kysely
            .insertInto("board_questions")
            .values({
                board_id: board.id,
                card_id: 0,
                prompt: "pick one",
                options: "[]",
                answer: SafeJSON.stringify(["a"]),
                answered_by: "user",
                delivered: 0,
                staged: 1,
                multi: 0,
                created_at: now,
                answered_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        const unansweredQuestion = await db.kysely
            .insertInto("board_questions")
            .values({
                board_id: board.id,
                card_id: 0,
                prompt: "pick two",
                options: "[]",
                answer: "",
                answered_by: "",
                delivered: 0,
                staged: 1,
                multi: 0,
                created_at: now,
                answered_at: "",
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        const result = await dispatchBoard(db, "b1");
        expect(result.opened).toEqual([staged.id]);
        expect(result.releasedQuestions).toEqual([answeredQuestion.id]);

        expect((await listWork(db, {})).map((w) => w.id)).toContain(staged.id);
        const stillStaged = await db.kysely
            .selectFrom("board_questions")
            .selectAll()
            .where("id", "=", unansweredQuestion.id)
            .executeTakeFirstOrThrow();
        expect(stillStaged.staged).toBe(1);
    });

    it("lease lifecycle: claim, same-session renew, different-session conflict with holder", async () => {
        const ok1 = await claimOrRenewLease(db, { kind: "board", board: "b1" }, "session-a", "alice");
        expect(ok1.conflict).toBe(false);

        const renewed = await claimOrRenewLease(db, { kind: "board", board: "b1" }, "session-a", "alice");
        expect(renewed.conflict).toBe(false);
        expect((renewed as { id: number }).id).toBe((ok1 as { id: number }).id);

        const conflict = await claimOrRenewLease(db, { kind: "board", board: "b1" }, "session-b", "bob");
        expect(conflict.conflict).toBe(true);
        if (conflict.conflict) {
            expect(conflict.holder.session).toBe("session-a");
            expect(conflict.holder.actor).toBe("alice");
        }
    });

    it("'all' scope never conflicts — each session keeps its own row", async () => {
        const a = await claimOrRenewLease(db, { kind: "all" }, "session-a", "alice");
        const b = await claimOrRenewLease(db, { kind: "all" }, "session-b", "bob");
        expect(a.conflict).toBe(false);
        expect(b.conflict).toBe(false);
        expect((a as { id: number }).id).not.toBe((b as { id: number }).id);
        expect((await listListeners(db)).length).toBe(2);
    });

    it("reapExpiredListeners reverts a claimed working item to open and clears claims", async () => {
        await createBoard(db, { slug: "b1" });
        const card = await makeCard(db, "b1", "proj/main/s1");
        const ann = await createAnnotation(db, {
            boardSlug: "b1",
            cardId: card.id,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });

        const lease = await claimOrRenewLease(db, { kind: "board", board: "b1" }, "session-a", "alice");
        expect(lease.conflict).toBe(false);
        const listenerId = (lease as { id: number }).id;
        await patchAnnotation(db, ann.id, { status: "working", claimedBy: "alice", claimedListener: listenerId });

        const staleIso = new Date(Date.now() - listenerTtlMs() - 1000).toISOString();
        await db.kysely.updateTable("listeners").set({ last_seen: staleIso }).where("id", "=", listenerId).execute();

        const reverted = await reapExpiredListeners(db);
        expect(reverted).toEqual([ann.id]);

        const row = await db.kysely
            .selectFrom("annotations")
            .selectAll()
            .where("id", "=", ann.id)
            .executeTakeFirstOrThrow();
        expect(row.status).toBe("open");
        expect(row.claimed_by).toBe("");
        expect(row.claimed_listener).toBe(0);
        expect((await listListeners(db)).length).toBe(0);
    });

    it("releaseLease reverts claimed items immediately", async () => {
        await createBoard(db, { slug: "b1" });
        const card = await makeCard(db, "b1", "proj/main/s1");
        const ann = await createAnnotation(db, {
            boardSlug: "b1",
            cardId: card.id,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });

        const lease = await claimOrRenewLease(db, { kind: "board", board: "b1" }, "session-a", "alice");
        const listenerId = (lease as { id: number }).id;
        await patchAnnotation(db, ann.id, { status: "working", claimedBy: "alice", claimedListener: listenerId });

        const reverted = await releaseLease(db, listenerId);
        expect(reverted).toEqual([ann.id]);
        const row = await db.kysely
            .selectFrom("annotations")
            .selectAll()
            .where("id", "=", ann.id)
            .executeTakeFirstOrThrow();
        expect(row.status).toBe("open");
    });

    it("drainChoices delivers an answered dispatched question exactly once", async () => {
        await createBoard(db, { slug: "b1" });
        const board = await db.kysely
            .selectFrom("boards")
            .selectAll()
            .where("slug", "=", "b1")
            .executeTakeFirstOrThrow();
        const now = new Date().toISOString();
        await db.kysely
            .insertInto("board_questions")
            .values({
                board_id: board.id,
                card_id: 0,
                prompt: "pick one",
                options: "[]",
                answer: SafeJSON.stringify(["a"]),
                answered_by: "user",
                delivered: 0,
                staged: 0,
                multi: 0,
                created_at: now,
                answered_at: now,
            })
            .execute();

        const first = await drainChoices(db, { kind: "board", board: "b1" });
        expect(first.length).toBe(1);
        expect(first[0].option).toEqual(["a"]);

        const second = await drainChoices(db, { kind: "board", board: "b1" });
        expect(second.length).toBe(0);
    });
});
