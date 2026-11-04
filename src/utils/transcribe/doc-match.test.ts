import { describe, expect, test } from "bun:test";
import { docIdentifiers, docLines, findReadAloud, findSpokenIdentifiers, restatesSpokenWords } from "./doc-match";

const doc = [
    "# Proposals",
    "",
    "## 3. Hidden sections: `hiddenOnly` in `ShelfData.sections[]`",
    "",
    "**Where:** chapter 2 „EntityData“, `ShelfData.sections[]`; chapter 4, `ShelfListDto.sections[]`.",
    "",
    "````diff",
    "- **Where:** chapter 2 „EntityData“, `ShelfData.sections[]`; chapter 4, `ShelfListDto.sections[]`.",
    " ```",
    " inner block",
    " ```",
    "````",
    "",
    "| GET | `/admin/cms/{type}/{key}/preview` | preview of a document |",
    "",
    "**Today:** the list is flat, so every nested section needs one more request to the server.",
].join("\n");

const entry = (text: string, startSec = 0) => ({ speaker: "Ann", startSec, text });

describe("docLines", () => {
    test("headings and paragraphs without markup; fenced blocks and table rows are left out", () => {
        const lines = docLines("proposals.md", doc);

        expect(lines.map((line) => line.line)).toEqual([3, 5, 16]);
        expect(lines[1]!.text.startsWith("Where: chapter 2")).toBe(true);
    });
});

describe("findReadAloud", () => {
    const lines = docLines("proposals.md", doc);

    test("a passage read aloud matches its line even when the reader skips the code and shortens words", () => {
        const found = findReadAloud({
            entries: [
                entry("So, where, chapter 2, entity data, shelf data sections, chap 4, shelf list sections, right."),
            ],
            lines,
        });

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ doc: "proposals.md", line: 5 });
        expect(found[0]!.heard.startsWith("where, chapter 2")).toBe(true);
    });

    test("a discussion of the same topic, with its words scattered, is no reading", () => {
        const found = findReadAloud({
            entries: [
                entry("I think the server could flatten it, but every section of the list, nested or not, is fine."),
            ],
            lines,
        });

        expect(found).toEqual([]);
    });
});

describe("findSpokenIdentifiers", () => {
    const identifiers = docIdentifiers(doc);

    test("identifiers come from code spans and hump or snake names", () => {
        expect(identifiers).toEqual(
            expect.arrayContaining(["hiddenOnly", "ShelfListDto.sections[]", "/admin/cms/{type}/{key}/preview"])
        );
    });

    test("words of an identifier said in order name it; a path segment after a cue or a slash is enough", () => {
        const found = findSpokenIdentifiers({
            entries: [
                entry("The hidden only flag stays, and the admin cms type key preview call too.", 0),
                entry("It ends with lomeno type, then a/preview.", 10),
            ],
            identifiers,
        });

        expect(found.map((match) => [match.heard, match.identifier])).toEqual([
            ["hidden only", "hiddenOnly"],
            ["admin cms type key preview", "/admin/cms/{type}/{key}/preview"],
            ["lomeno type", "/{type}"],
            ["preview", "/preview"],
        ]);
    });

    test("a list is no path, and a repeated mention is marked again only after a while", () => {
        const found = findSpokenIdentifiers({
            entries: [
                entry("We have hidden, only some.", 0),
                entry("hidden only", 10),
                entry("hidden only", 20),
                entry("hidden only", 200),
            ],
            identifiers,
        });

        expect(found.map((match) => match.entry)).toEqual([1, 3]);
    });
});

describe("restatesSpokenWords", () => {
    test("a plain code name made of the said words only restates them", () => {
        expect(restatesSpokenWords("entity data", "EntityData")).toBe(true);
        expect(restatesSpokenWords("lead template", "leadTemplate")).toBe(true);
        expect(restatesSpokenWords("tile DTO", "TileDto")).toBe(true);
    });

    test("a path, a member chain, a constant code or an unsaid word adds something", () => {
        expect(restatesSpokenWords("lomeno type", "/{type}")).toBe(false);
        expect(restatesSpokenWords("product data offer section", "ProductData.offerSection")).toBe(false);
        expect(restatesSpokenWords("no projection", "NO_PROJECTION")).toBe(false);
        expect(restatesSpokenWords("list DTO", "ProductListDto")).toBe(false);
    });
});
