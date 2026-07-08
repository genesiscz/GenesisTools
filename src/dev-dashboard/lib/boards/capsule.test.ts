import { describe, expect, it } from "bun:test";
import { buildCapsule } from "./capsule";
import type { AnnotationDto, CardDto } from "./types";

function makeAnnotation(overrides: Partial<AnnotationDto> = {}): AnnotationDto {
    return {
        id: 17,
        boardId: 1,
        boardSlug: "my-board",
        cardId: 5,
        region: { x: 10, y: 20, w: 100, h: 50 },
        intent: "fix",
        intentOther: "",
        status: "open",
        assignee: "claude",
        createdBy: "user",
        cardVersion: 1,
        prompt: "fix the button color",
        revisions: [
            { id: 1, prompt: "fix the button color", createdBy: "user", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
        messages: [],
        attempts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

function makeCard(overrides: Partial<CardDto> = {}): CardDto {
    return {
        id: 5,
        boardId: 1,
        kind: "shot",
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        z: 0,
        setRef: "proj/main/s1",
        setVersion: 2,
        filePath: "home.png",
        blobKey: "deadbeef.png",
        payload: {},
        createdBy: "",
        elemNo: 1,
        currentVersion: 1,
        ...overrides,
    };
}

describe("buildCapsule", () => {
    it("includes the №id header, region line, and source line", () => {
        const capsule = buildCapsule(makeAnnotation(), makeCard(), "my-board");
        expect(capsule).toContain("# boards work №17 · fix · board my-board");
        expect(capsule).toContain("**Region:** 10,20 100×50 px on `home.png` — image: /api/boards/blobs/deadbeef.png");
        expect(capsule).toContain("**Source:** set `proj/main/s1` v2 (card 5, drawn on v1)");
        expect(capsule).toContain("**Ask (rev 1):** fix the button color");
    });

    it("includes the standard protocol line without the reshoot caveat for a normal intent", () => {
        const capsule = buildCapsule(makeAnnotation(), makeCard(), "my-board");
        expect(capsule).toContain("**Protocol:** boards_set_status working");
        expect(capsule).not.toContain("reshoot intent");
    });

    it("replaces the default protocol with the reshoot protocol when intent is reshoot", () => {
        const capsule = buildCapsule(makeAnnotation({ intent: "reshoot" }), makeCard(), "my-board");
        expect(capsule).toContain("**Protocol (reshoot):** NO code changes");
        expect(capsule).toContain("boards_attach_after");
        expect(capsule).not.toContain("**Protocol:** boards_set_status working");
    });

    it("uses intentOther for an 'other' intent", () => {
        const capsule = buildCapsule(
            makeAnnotation({ intent: "other", intentOther: "spacing nit" }),
            makeCard(),
            "my-board"
        );
        expect(capsule).toContain("# boards work №17 · spacing nit · board my-board");
    });

    it("clips long thread messages and caps to the last THREAD_LIMIT entries", () => {
        const longBody = "x".repeat(400);
        const messages = Array.from({ length: 7 }, (_, i) => ({
            id: i,
            annotationId: 17,
            boardId: null,
            author: "claude",
            body: i === 6 ? longBody : `msg-${i}`,
            createdAt: "2026-01-01T00:00:00.000Z",
        }));
        const capsule = buildCapsule(makeAnnotation({ messages }), makeCard(), "my-board");
        expect(capsule).toContain("**Thread (latest):**");
        expect(capsule).not.toContain("msg-0"); // outside the last 5
        expect(capsule).toContain("msg-2");
        expect(capsule).toContain(`${"x".repeat(300)}…`);
    });

    it("omits the image suffix and source line when the card has no blob/setRef", () => {
        const capsule = buildCapsule(makeAnnotation(), makeCard({ blobKey: "", setRef: "", filePath: "" }), "my-board");
        expect(capsule).toContain("**Region:** 10,20 100×50 px on `shot`");
        expect(capsule).not.toContain("— image:");
        expect(capsule).not.toContain("**Source:**");
    });

    it("adds a Section line with a scoped scrape URL when the card sits inside a journey section", () => {
        const section = { id: 99, kind: "section", x: 0, y: 0, w: 500, h: 500, payload: { title: "Checkout" } };
        const capsule = buildCapsule(makeAnnotation(), makeCard(), "my-board", { boardCards: [section, makeCard()] });
        expect(capsule).toContain(
            "**Section:** Checkout — scoped digest: /api/boards/my-board/scrape?section=Checkout"
        );
    });

    it("prefixes the Section digest URL with base when given", () => {
        const section = { id: 99, kind: "section", x: 0, y: 0, w: 500, h: 500, payload: { title: "Checkout" } };
        const capsule = buildCapsule(makeAnnotation(), makeCard(), "my-board", {
            boardCards: [section, makeCard()],
            base: "http://127.0.0.1:1234",
        });
        expect(capsule).toContain(
            "**Section:** Checkout — scoped digest: http://127.0.0.1:1234/api/boards/my-board/scrape?section=Checkout"
        );
    });

    it("omits the Section line when the card isn't inside any section, or boardCards isn't given", () => {
        const outside = { id: 99, kind: "section", x: 900, y: 900, w: 50, h: 50, payload: { title: "Elsewhere" } };
        expect(buildCapsule(makeAnnotation(), makeCard(), "my-board", { boardCards: [outside] })).not.toContain(
            "**Section:**"
        );
        expect(buildCapsule(makeAnnotation(), makeCard(), "my-board")).not.toContain("**Section:**");
    });
});
