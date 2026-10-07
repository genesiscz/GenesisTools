import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileLink } from "./file-link";

// What a "/Users/m" path links to here: "file:///Users/m" on POSIX, "file:///C:/Users/m" on Windows.
const USERS_M = pathToFileURL(resolve("/Users/m")).href;

describe("fileLink", () => {
    test("renders the short name and line as text and a file URL with #L as target", () => {
        expect(fileLink("/Users/m/app/packages/a/Modal.tsx", 91)).toBe(
            `[Modal.tsx:91](${USERS_M}/app/packages/a/Modal.tsx#L91)`
        );
    });

    test("falls back to line 1 when there is no line, so the label always carries one", () => {
        expect(fileLink("/Users/m/a b/x.ts")).toBe(`[x.ts:1](${USERS_M}/a%20b/x.ts#L1)`);
        expect(fileLink("/Users/m/x.ts", 0)).toBe(`[x.ts:1](${USERS_M}/x.ts#L1)`);
    });

    test("keeps ? and # inside the path instead of starting a query or a fragment", () => {
        expect(fileLink("/Users/m/a?b/x#1.ts", 3)).toBe(`[x#1.ts:3](${USERS_M}/a%3Fb/x%231.ts#L3)`);
    });

    test("makes a relative path absolute, so its first segment never becomes the URL host", () => {
        expect(fileLink("relative/x.ts", 2)).toBe(`[x.ts:2](${pathToFileURL(resolve("relative/x.ts")).href}#L2)`);
    });
});
