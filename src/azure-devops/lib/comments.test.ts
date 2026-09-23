import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentPreview, parseCommentId, resolveCommentBody, resolveWorkItemId } from "@app/azure-devops/lib/comments";

const dir = await mkdtemp(join(tmpdir(), "ado-comments-"));

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("resolveWorkItemId", () => {
    test("reads a bare id and an edit URL", () => {
        expect(resolveWorkItemId("123")).toBe(123);
        expect(resolveWorkItemId("https://dev.azure.com/contoso/Widgets/_workitems/edit/456/")).toBe(456);
    });

    test("refuses a list of ids", () => {
        expect(() => resolveWorkItemId("1,2")).toThrow("Expected one work item");
    });
});

describe("parseCommentId", () => {
    test("accepts a positive whole number only", () => {
        expect(parseCommentId("42")).toBe(42);
        expect(() => parseCommentId("0")).toThrow("Invalid comment id");
        expect(() => parseCommentId("4.2")).toThrow("Invalid comment id");
    });
});

describe("resolveCommentBody", () => {
    test("needs exactly one source", async () => {
        await expect(resolveCommentBody({})).rejects.toThrow("exactly one");
        await expect(resolveCommentBody({ text: "a", file: "b" })).rejects.toThrow("exactly one");
    });

    test("reads a file and trims only the trailing whitespace", async () => {
        const path = join(dir, "comment.md");
        await writeFile(path, "  **Hello**\n\nbody\n\n");

        expect(await resolveCommentBody({ file: path })).toBe("  **Hello**\n\nbody");
    });

    test("reads stdin for '-'", async () => {
        expect(await resolveCommentBody({ file: "-", readStdin: async () => "from stdin\n" })).toBe("from stdin");
    });

    test("names a missing file and refuses an empty comment", async () => {
        await expect(resolveCommentBody({ file: join(dir, "missing.md") })).rejects.toThrow("File not found");
        await expect(resolveCommentBody({ text: " \n " })).rejects.toThrow("empty");
    });
});

describe("commentPreview", () => {
    test("takes the first non-empty line without tags and cuts it to the width", () => {
        expect(commentPreview("<div>\n\n<b>Hi</b> there\nsecond</div>")).toBe("Hi there");
        expect(commentPreview("@Someone &nbsp;a &amp; b")).toBe("@Someone a & b");
        expect(commentPreview("x".repeat(10), 5)).toBe("xxxx…");
    });
});
