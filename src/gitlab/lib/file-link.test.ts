import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileLink } from "./file-link";

// What a "/Users/m" path links to here: "/Users/m" on POSIX, "/C:/Users/m" on Windows.
const USERS_M = pathToFileURL(resolve("/Users/m")).pathname;

describe("fileLink", () => {
    test("renders the file name and line as text and the plain absolute path with #L as target", () => {
        expect(fileLink("/Users/m/app/packages/a/Modal.tsx", 91)).toBe(
            `[Modal.tsx:91](${USERS_M}/app/packages/a/Modal.tsx#L91)`
        );
    });

    test("labels the path relative to the root, and falls back to the file name outside it", () => {
        expect(fileLink("/Users/m/app/packages/a/Modal.tsx", 91, { root: "/Users/m/app" })).toBe(
            `[packages/a/Modal.tsx:91](${USERS_M}/app/packages/a/Modal.tsx#L91)`
        );
        expect(fileLink("/Users/m/other/x.ts", 2, { root: "/Users/m/app" })).toBe(`[x.ts:2](${USERS_M}/other/x.ts#L2)`);
    });

    test("shows a range in the label and the fragment", () => {
        expect(fileLink("/Users/m/x.ts", 3, { endLine: 10 })).toBe(`[x.ts:3-10](${USERS_M}/x.ts#L3-L10)`);
        expect(fileLink("/Users/m/x.ts", 3, { endLine: 3 })).toBe(`[x.ts:3](${USERS_M}/x.ts#L3)`);
    });

    test("links the file alone when there is no line", () => {
        expect(fileLink("/Users/m/a b/x.ts")).toBe(`[x.ts](${USERS_M}/a%20b/x.ts)`);
        expect(fileLink("/Users/m/x.ts", 0)).toBe(`[x.ts](${USERS_M}/x.ts)`);
    });

    test("keeps ? and # inside the path instead of starting a query or a fragment", () => {
        expect(fileLink("/Users/m/a?b/x#1.ts", 3)).toBe(`[x#1.ts:3](${USERS_M}/a%3Fb/x%231.ts#L3)`);
    });

    test("makes a relative path absolute", () => {
        expect(fileLink("relative/x.ts", 2)).toBe(`[x.ts:2](${pathToFileURL(resolve("relative/x.ts")).pathname}#L2)`);
    });
});

test("Markdown-special file names keep an intact label, destination and line fragment", () => {
    expect(fileLink("/Users/m/file).ts", 3)).toBe(`[file).ts:3](${USERS_M}/file%29.ts#L3)`);
    expect(fileLink("/Users/m/[file].ts", 3)).toBe(`[\\[file\\].ts:3](${USERS_M}/%5Bfile%5D.ts#L3)`);
    expect(fileLink("/Users/m/(file).ts", 3, { endLine: 4 })).toBe(`[(file).ts:3-4](${USERS_M}/%28file%29.ts#L3-L4)`);
});
