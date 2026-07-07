import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import {
    addAttempt,
    addMessage,
    addRevision,
    CancelledError,
    cancelAnnotation,
    createAnnotation,
    deleteAnnotation,
    getAnnotation,
    InvalidStatusError,
    NotCancellableError,
    NotUndoableError,
    patchAnnotation,
    reactivateAnnotation,
    setVerdict,
} from "./annotations-store";
import { createBoard, createCard, getBoardDoc, listCardVersions } from "./boards-store";
import { BOOTSTRAP_DDL } from "./db";
import type { BoardsDb } from "./db-types";
import { NotFoundError } from "./sets-store";
import type { Region } from "./types";

function makeTestDb(): DatabaseClient<BoardsDb> {
    return createKyselyClient<BoardsDb>({ path: ":memory:", bootstrap: BOOTSTRAP_DDL, pragmas: { foreignKeys: true } });
}

const REGION: Region = { x: 1, y: 2, w: 3, h: 4 };

describe("annotations-store", () => {
    let db: DatabaseClient<BoardsDb>;
    let boardSlug: string;
    let cardId: number;

    beforeEach(async () => {
        db = makeTestDb();
        boardSlug = "b1";
        await createBoard(db, { slug: boardSlug });
        const card = await createCard(db, boardSlug, {
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
        cardId = card.id;
    });

    afterEach(() => {
        db.close();
    });

    it("createAnnotation defaults to staged, seeds revision #1, and stamps cardVersion from the card", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "fix this",
        });
        expect(ann.status).toBe("staged");
        expect(ann.boardSlug).toBe(boardSlug);
        expect(ann.revisions.length).toBe(1);
        expect(ann.revisions[0].prompt).toBe("fix this");
        expect(ann.prompt).toBe("fix this");
        expect(ann.cardVersion).toBe(1);
    });

    it("PATCH cannot set status=cancelled directly — only the cancel endpoint may", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        await expect(patchAnnotation(db, ann.id, { status: "cancelled" })).rejects.toBeInstanceOf(InvalidStatusError);
    });

    it("cancel works from staged/open/working; not from in_review", async () => {
        const staged = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "staged",
        });
        expect((await cancelAnnotation(db, staged.id)).status).toBe("cancelled");

        const open = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        expect((await cancelAnnotation(db, open.id)).status).toBe("cancelled");

        const working = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        await patchAnnotation(db, working.id, { status: "working" });
        expect((await cancelAnnotation(db, working.id)).status).toBe("cancelled");

        const inReview = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        await patchAnnotation(db, inReview.id, { status: "working" });
        await patchAnnotation(db, inReview.id, { status: "in_review" });
        await expect(cancelAnnotation(db, inReview.id)).rejects.toBeInstanceOf(NotCancellableError);
    });

    it("any write to a cancelled annotation throws CancelledError", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        await cancelAnnotation(db, ann.id);

        await expect(patchAnnotation(db, ann.id, { region: REGION })).rejects.toBeInstanceOf(CancelledError);
        await expect(addRevision(db, ann.id, "new prompt", "user")).rejects.toBeInstanceOf(CancelledError);
        await expect(addMessage(db, { annotationId: ann.id, author: "user", body: "hi" })).rejects.toBeInstanceOf(
            CancelledError
        );
        await expect(
            addAttempt(db, {
                annotationId: ann.id,
                afterSetRef: "proj/main/s1",
                afterVersion: 2,
                afterFile: "a.png",
                afterBlobKey: "hash2.png",
            })
        ).rejects.toBeInstanceOf(CancelledError);
    });

    it("claim CAS: working succeeds only from open; a second claim fails", async () => {
        const staged = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "staged",
        });
        await expect(patchAnnotation(db, staged.id, { status: "working" })).rejects.toBeInstanceOf(InvalidStatusError);

        const open = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        const claimed = await patchAnnotation(db, open.id, {
            status: "working",
            claimedBy: "claude",
            claimedListener: 5,
        });
        expect(claimed.status).toBe("working");

        await expect(patchAnnotation(db, open.id, { status: "working" })).rejects.toBeInstanceOf(InvalidStatusError);
    });

    it("reactivate flips cancelled back to staged", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        await cancelAnnotation(db, ann.id);
        expect((await reactivateAnnotation(db, ann.id)).status).toBe("staged");
    });

    it("delete allows pristine staged/open, refuses once messages or attempts exist", async () => {
        const staged = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "staged",
        });
        await deleteAnnotation(db, staged.id);
        await expect(getAnnotation(db, staged.id)).rejects.toBeInstanceOf(NotFoundError);

        const open = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        await deleteAnnotation(db, open.id);

        const withMessage = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        await addMessage(db, { annotationId: withMessage.id, author: "user", body: "hi" });
        await expect(deleteAnnotation(db, withMessage.id)).rejects.toBeInstanceOf(NotUndoableError);
    });

    it("a user reply on in_review/working re-queues to open and clears the claim; an agent reply does not", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
            assignee: "claude",
        });
        await patchAnnotation(db, ann.id, { status: "working", claimedBy: "claude", claimedListener: 7 });
        await patchAnnotation(db, ann.id, { status: "in_review" });

        await addMessage(db, { annotationId: ann.id, author: "claude", body: "done" });
        expect((await getAnnotation(db, ann.id)).status).toBe("in_review");

        await addMessage(db, { annotationId: ann.id, author: "user", body: "not quite" });
        expect((await getAnnotation(db, ann.id)).status).toBe("open");
    });

    it("a staged prompt edit replaces the revision in place; a post-dispatch edit appends", async () => {
        const staged = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "v1",
            status: "staged",
        });
        expect(staged.revisions.length).toBe(1);
        const edited = await addRevision(db, staged.id, "v1-edited", "user");
        expect(edited.revisions.length).toBe(1);
        expect(edited.revisions[0].prompt).toBe("v1-edited");

        const open = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "o1",
            status: "open",
        });
        const appended = await addRevision(db, open.id, "o2", "user");
        expect(appended.revisions.length).toBe(2);
        expect(appended.prompt).toBe("o2");
    });

    it("an attempt swaps the card face immediately with provenance; accept resolves and keeps the face", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        const { attempt, card } = await addAttempt(db, {
            annotationId: ann.id,
            afterSetRef: "proj/main/s1",
            afterVersion: 2,
            afterFile: "a.png",
            afterBlobKey: "hash2.png",
        });
        expect(card.blobKey).toBe("hash2.png");
        expect(card.currentVersion).toBe(2);
        expect(attempt.afterBlobKey).toBe("hash2.png");
        expect(attempt.verdict).toBe("");

        const result = await setVerdict(db, attempt.id, "accept");
        expect(result.annotation.status).toBe("resolved");
        expect(result.card.blobKey).toBe("hash2.png");
    });

    it("reject rolls the card face back to the pre-attempt blob; history keeps both versions", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });
        const { attempt } = await addAttempt(db, {
            annotationId: ann.id,
            afterSetRef: "proj/main/s1",
            afterVersion: 2,
            afterFile: "a.png",
            afterBlobKey: "hash2.png",
        });
        const result = await setVerdict(db, attempt.id, "reject");
        expect(result.card.blobKey).toBe("hash1.png");
        expect(result.card.currentVersion).toBe(1);
        expect(result.annotation.status).toBe("open");

        const versions = await listCardVersions(db, cardId);
        expect(versions.map((v) => v.blobKey)).toEqual(["hash1.png", "hash2.png"]);
    });

    it("a chain of attempt/reject cycles always lands on the last surviving (non-rejected) face", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });

        const first = await addAttempt(db, {
            annotationId: ann.id,
            afterSetRef: "proj/main/s1",
            afterVersion: 2,
            afterFile: "a.png",
            afterBlobKey: "hash2.png",
        });
        const firstReject = await setVerdict(db, first.attempt.id, "reject");
        expect(firstReject.card.blobKey).toBe("hash1.png");

        // Regression: must not crash re-minting a version number that already exists in history
        // (hash2.png's rejected row is still there), and must not land back on the rejected face.
        const second = await addAttempt(db, {
            annotationId: ann.id,
            afterSetRef: "proj/main/s1",
            afterVersion: 3,
            afterFile: "a.png",
            afterBlobKey: "hash3.png",
        });
        expect(second.card.blobKey).toBe("hash3.png");
        const secondReject = await setVerdict(db, second.attempt.id, "reject");
        expect(secondReject.card.blobKey).toBe("hash1.png");
        expect(secondReject.card.currentVersion).toBe(1);

        const versions = await listCardVersions(db, cardId);
        expect(versions.map((v) => v.blobKey)).toEqual(["hash1.png", "hash2.png", "hash3.png"]);
    });

    it("getBoardDoc embeds full annotation detail (revisions/messages/attempts), not the Task-6 empty stub", async () => {
        const ann = await createAnnotation(db, {
            boardSlug,
            cardId,
            region: REGION,
            intent: "fix",
            prompt: "fix it",
            status: "open",
        });
        await addMessage(db, { annotationId: ann.id, author: "user", body: "please" });
        const { attempt } = await addAttempt(db, {
            annotationId: ann.id,
            afterSetRef: "proj/main/s1",
            afterVersion: 2,
            afterFile: "a.png",
            afterBlobKey: "hash2.png",
        });

        const doc = await getBoardDoc(db, boardSlug);
        expect(doc.annotations.length).toBe(1);
        const embedded = doc.annotations[0];
        expect(embedded.id).toBe(ann.id);
        expect(embedded.revisions.length).toBe(1);
        expect(embedded.messages.length).toBe(1);
        expect(embedded.attempts.length).toBe(1);
        expect(embedded.attempts[0].id).toBe(attempt.id);
    });
});
