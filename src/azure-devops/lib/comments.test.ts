import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPages } from "@app/azure-devops/api";
import {
    adoOrganizationOf,
    commentPreview,
    deleteCommentWithConsent,
    parseCommentId,
    resolveCommentBody,
    resolveWorkItemId,
} from "@app/azure-devops/lib/comments";

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

    test("refuses id 0 and an id past 2^53 that would round to another work item", () => {
        for (const input of ["0", "9007199254740993", "https://dev.azure.com/contoso/Widgets/_workitems/edit/0/"]) {
            expect(() => resolveWorkItemId(input)).toThrow("Invalid work item ID");
        }

        expect(resolveWorkItemId("9007199254740991")).toBe(9007199254740991);
    });

    test("refuses a URL from another organization than the configured one", () => {
        const url = "https://dev.azure.com/contoso/Widgets/_workitems/edit/456/";
        expect(() => resolveWorkItemId(url, "https://dev.azure.com/fabrikam")).toThrow(
            "organization 'contoso', but the configured organization is 'fabrikam'"
        );
        expect(resolveWorkItemId(url, "https://contoso.visualstudio.com")).toBe(456);
        expect(resolveWorkItemId(url, "https://dev.azure.com/Contoso/")).toBe(456);
        expect(resolveWorkItemId("456", "https://dev.azure.com/fabrikam")).toBe(456);
    });
});

describe("adoOrganizationOf", () => {
    test("names the organization of both URL shapes and of a server", () => {
        expect(adoOrganizationOf("https://dev.azure.com/Contoso/Widgets")).toBe("contoso");
        expect(adoOrganizationOf("https://contoso.visualstudio.com/Widgets")).toBe("contoso");
        expect(adoOrganizationOf("https://tfs.example.com/tfs/Default")).toBe("tfs.example.com");
        expect(adoOrganizationOf("456")).toBeNull();
    });
});

describe("parseCommentId", () => {
    test("accepts a positive whole number only", () => {
        expect(parseCommentId("42")).toBe(42);
        expect(() => parseCommentId("0")).toThrow("Invalid comment id");
        expect(() => parseCommentId("4.2")).toThrow("Invalid comment id");
    });

    test("refuses hex, exponent, signed and unsafe forms that Number() would accept", () => {
        for (const value of ["0x10", "1e3", "+5", "", "9007199254740993"]) {
            expect(() => parseCommentId(value)).toThrow("Invalid comment id");
        }
    });
});

describe("deleteCommentWithConsent", () => {
    /** The DELETE spy throws unless the test expects it to run, so a guard that leaks fails loudly. */
    function deletion(allowed: boolean) {
        const state = { removed: 0, asked: 0 };
        const remove = async () => {
            state.removed += 1;

            if (!allowed) {
                throw new Error("deleteComment reached without consent");
            }
        };

        return { state, remove };
    }

    test("without a terminal and without --yes nothing is deleted and nothing is asked", async () => {
        const { state, remove } = deletion(false);
        const confirm = async () => {
            state.asked += 1;
            return true;
        };

        expect(await deleteCommentWithConsent({ yes: false, interactive: false, confirm, remove })).toBe("needs-yes");
        expect(state).toEqual({ removed: 0, asked: 0 });
    });

    test("a no at the prompt deletes nothing", async () => {
        const { state, remove } = deletion(false);

        expect(
            await deleteCommentWithConsent({ yes: false, interactive: true, confirm: async () => false, remove })
        ).toBe("declined");
        expect(state.removed).toBe(0);
    });

    test("a yes at the prompt, or --yes without asking, reaches the DELETE once (negative control)", async () => {
        const prompted = deletion(true);
        const flagged = deletion(true);
        const neverAsk = async () => {
            throw new Error("--yes must not prompt");
        };

        expect(
            await deleteCommentWithConsent({
                yes: false,
                interactive: true,
                confirm: async () => true,
                remove: prompted.remove,
            })
        ).toBe("deleted");
        expect(
            await deleteCommentWithConsent({ yes: true, interactive: false, confirm: neverAsk, remove: flagged.remove })
        ).toBe("deleted");
        expect([prompted.state.removed, flagged.state.removed]).toEqual([1, 1]);
    });
});

describe("collectPages", () => {
    test("follows the continuation token to the last page, and stops on a repeated token", async () => {
        const pages: Record<string, { items: number[]; next?: string }> = {
            first: { items: [3, 2], next: "b" },
            b: { items: [1], next: "c" },
            c: { items: [0] },
        };
        const asked: Array<string | undefined> = [];

        expect(
            await collectPages(async (token) => {
                asked.push(token);
                return pages[token ?? "first"];
            })
        ).toEqual([3, 2, 1, 0]);
        expect(asked).toEqual([undefined, "b", "c"]);
        expect(await collectPages(async () => ({ items: [1], next: "same" }))).toEqual([1, 1]);
    });

    test("stops on a cycle that returns to an earlier token", async () => {
        const cycle: Record<string, { items: string[]; next: string }> = {
            start: { items: ["p0"], next: "a" },
            a: { items: ["pa"], next: "b" },
            b: { items: ["pb"], next: "a" },
        };
        let calls = 0;

        const items = await collectPages(async (token) => {
            calls += 1;

            if (calls > 10) {
                throw new Error("pagination did not stop on the a → b → a cycle");
            }

            return cycle[token ?? "start"];
        });

        expect(items).toEqual(["p0", "pa", "pb"]);
        expect(calls).toBe(3);
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
