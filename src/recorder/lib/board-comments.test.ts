import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readComments } from "@genesiscz/utils/recording-editor/comments";
import { wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import { type BoardDigestReader, type BoardRef, parseBoardRef, promptTime } from "./board-comments";
import { importBoardComments, uncomment } from "./review";

const root = mkdtempSync(join(tmpdir(), "gt-test-board-comments-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CROP = "https://app.example.test/w/team/api/v1/annotations";

/** A board digest as the vitrinka MCP's scrape_board answers it (extra fields included), with four annotations. */
const DIGEST = {
    board: { slug: "demo-review" },
    cards: [
        {
            id: 11,
            kind: "shot",
            vs: 3,
            annotations: [
                {
                    id: 101,
                    by: "Alice",
                    intent: "fix",
                    status: "open",
                    prompt: "0:12 the cursor jumps",
                    cropUrl: `${CROP}/101/crop.png`,
                },
                {
                    id: 102,
                    by: "Bob",
                    intent: "fix",
                    status: "resolved",
                    prompt: "[0:03-0:05] caption too early",
                    cropUrl: `${CROP}/102/crop.png`,
                },
            ],
        },
        {
            id: 12,
            kind: "step",
            annotations: [
                {
                    id: 103,
                    by: "Alice",
                    intent: "comment",
                    status: "open",
                    prompt: "3 buttons are off",
                    cropUrl: `${CROP}/103/crop.png`,
                },
            ],
        },
        {
            id: 13,
            kind: "callout",
            annotations: [
                {
                    id: 104,
                    by: "Alice",
                    intent: "fix",
                    status: "open",
                    prompt: "rename this",
                    cropUrl: `${CROP}/104/crop.png`,
                },
            ],
        },
    ],
};

/** A fixture reader: the digest, and the refs it was asked for. Never a real board. */
function fixtureReader(): { read: BoardDigestReader; asked: BoardRef[] } {
    const asked: BoardRef[] = [];
    return {
        asked,
        read: async (ref) => {
            asked.push(ref);
            return DIGEST;
        },
    };
}

/** An edit of a 60 s movie that cuts 10 s to 20 s, so OUTPUT 12 s is SOURCE 22 s. */
function recording(name: string): string {
    const folder = join(root, name);
    mkdirSync(folder, { recursive: true });
    const project = wholeProject({ video: join(folder, "movie.mov"), durationUs: 60_000_000, width: 640, height: 360 });
    const path = join(folder, "movie.edit.json");
    writeProject(path, {
        ...project,
        clips: [
            { ...project.clips[0], id: "c1", fromUs: 0, toUs: 10_000_000 },
            { ...project.clips[0], id: "c2", fromUs: 20_000_000, toUs: 60_000_000 },
        ],
    });
    return path;
}

describe("a board reference", () => {
    it("reads a board link with its card, <workspace>/<slug> and a bare slug; --card wins", () => {
        expect(parseBoardRef("https://app.example.test/w/team/boards/demo-review?card=11")).toEqual({
            board: "demo-review",
            workspace: "team",
            origin: "https://app.example.test",
            card: 11,
        });
        expect(parseBoardRef("team/demo-review")).toEqual({ board: "demo-review", workspace: "team" });
        expect(parseBoardRef("demo-review", 12)).toEqual({ board: "demo-review", card: 12 });
        expect(parseBoardRef("https://app.example.test/w/team/boards/demo-review?card=11", 12).card).toBe(12);
        expect(() => parseBoardRef("https://app.example.test/w/team/tasks/9")).toThrow("not a vitrinka board link");
    });
});

describe("the time at the start of an annotation", () => {
    it("takes a clock, a range or seconds with their s, and nothing else", () => {
        expect(promptTime("0:12 the cursor jumps")).toEqual({ atSec: 12, rest: "the cursor jumps" });
        expect(promptTime("@1:02:03.5 - fade")).toEqual({ atSec: 3723.5, rest: "fade" });
        expect(promptTime("[0:03-0:05] caption")).toEqual({ atSec: 3, toSec: 5, rest: "caption" });
        expect(promptTime("42s: too slow")).toEqual({ atSec: 42, rest: "too slow" });
        expect(promptTime("3 buttons are off")).toBeUndefined();
        expect(promptTime("the cursor at 0:12 jumps")).toBeUndefined();
    });
});

describe("importing a board's annotations as review comments", () => {
    it("adds the screen cards' annotations at their output times, 0:00 with a note without one", async () => {
        const path = recording("whole-board");
        const { read, asked } = fixtureReader();
        const result = await importBoardComments(path, { board: "team/demo-review", read });

        expect(asked).toEqual([{ board: "demo-review", workspace: "team" }]);
        // In board order; the comments file reads back in time order.
        expect(result.added.map((c) => [c.text, c.from, c.plays, c.author, c.resolved])).toEqual([
            ["the cursor jumps", 22, 12, "Alice", false],
            ["caption too early", 3, 3, "Bob", true],
            ["[no time on the board; placed at 0:00] 3 buttons are off", 0, 0, "Alice", false],
        ]);
        expect(result.untimed).toBe(1);
        expect(result.notOnScreens).toBe(1);
        expect(result.added[0]?.link).toBe("https://app.example.test/w/team/boards/demo-review?card=11#annotation-101");
        expect(readComments(result.path).map((c) => c.atUs)).toEqual([0, 3_000_000, 22_000_000]);
    });

    it("adds nothing on a second import, also after a comment was removed", async () => {
        const path = recording("twice");
        const { read } = fixtureReader();
        const first = await importBoardComments(path, { board: "team/demo-review", read });
        const removed = first.added[0];

        if (!removed) {
            throw new Error("the first import added nothing");
        }

        await uncomment(path, removed.id);
        const before = readFileSync(first.path, "utf8");
        const again = await importBoardComments(path, { board: "team/demo-review", read });

        expect(again.added).toEqual([]);
        expect(again.alreadyImported).toBe(3);
        expect(readFileSync(first.path, "utf8")).toBe(before);
    });

    it("imports one card's annotations from a card link, a note card too", async () => {
        const path = recording("one-card");
        const { read } = fixtureReader();
        const result = await importBoardComments(path, {
            board: "https://app.example.test/w/team/boards/demo-review?card=13",
            read,
        });

        expect(result.added.map((c) => c.text)).toEqual(["[no time on the board; placed at 0:00] rename this"]);
        await expect(importBoardComments(path, { board: "team/demo-review", card: 99, read })).rejects.toThrow(
            "has no card 99"
        );
    });

    it("writes nothing on a dry run", async () => {
        const path = recording("dry");
        const { read } = fixtureReader();
        const result = await importBoardComments(path, { board: "team/demo-review", dryRun: true, read });

        expect(result.wouldAdd).toHaveLength(3);
        expect(result.added).toEqual([]);
        expect(existsSync(result.path)).toBe(false);
    });
});
