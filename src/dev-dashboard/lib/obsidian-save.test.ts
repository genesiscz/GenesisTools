import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveToObsidianUnique } from "./obsidian-save";

describe("saveToObsidianUnique", () => {
    let vaultRoot = "";

    afterEach(async () => {
        if (vaultRoot) {
            await rm(vaultRoot, { recursive: true, force: true });
            vaultRoot = "";
        }
    });

    test("creates unique suffix when file exists", async () => {
        vaultRoot = await mkdtemp(join(tmpdir(), "vault-"));
        const dir = "notes";

        await saveToObsidianUnique({
            vaultRoot,
            relativeDir: dir,
            baseName: "test-note",
            content: "first",
            mode: "create",
            createDir: true,
        });

        const second = await saveToObsidianUnique({
            vaultRoot,
            relativeDir: dir,
            baseName: "test-note",
            content: "second",
            mode: "create",
            createDir: true,
        });

        expect(second.path).toContain("test-note-2.md");
        const body = await readFile(second.path, "utf8");
        expect(body).toBe("second");
    });

    test("rejects directory traversal", async () => {
        vaultRoot = await mkdtemp(join(tmpdir(), "vault-"));

        await expect(
            saveToObsidianUnique({
                vaultRoot,
                relativeDir: "../outside",
                baseName: "note",
                content: "nope",
                mode: "create",
                createDir: true,
            })
        ).rejects.toThrow(/escapes vault/);
    });

    test("rejects filename traversal", async () => {
        vaultRoot = await mkdtemp(join(tmpdir(), "vault-"));

        await expect(
            saveToObsidianUnique({
                vaultRoot,
                relativeDir: "inbox",
                baseName: "../../etc/passwd",
                content: "nope",
                mode: "create",
                createDir: true,
            })
        ).rejects.toThrow(/escapes vault/);
    });

    test("appends to existing file", async () => {
        vaultRoot = await mkdtemp(join(tmpdir(), "vault-"));
        const first = await saveToObsidianUnique({
            vaultRoot,
            relativeDir: "inbox",
            baseName: "append-me",
            content: "line one",
            mode: "create",
            createDir: true,
        });

        await saveToObsidianUnique({
            vaultRoot,
            relativeDir: "inbox",
            baseName: "append-me",
            content: "line two",
            mode: "append",
            createDir: true,
        });

        const body = await readFile(first.path, "utf8");
        expect(body).toContain("line one");
        expect(body).toContain("line two");
    });
});
