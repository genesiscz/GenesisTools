import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRepo } from "./store-repo";

let storeDir: string;
beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "stash-store-"));
});
afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
});

describe("StoreRepo", () => {
    test("init creates a bare git repo", async () => {
        const repo = new StoreRepo(storeDir);
        await repo.init();
        const { existsSync } = await import("node:fs");
        expect(existsSync(join(storeDir, "HEAD"))).toBe(true);
        expect(existsSync(join(storeDir, "refs"))).toBe(true);
    });

    test("init is idempotent", async () => {
        const repo = new StoreRepo(storeDir);
        await repo.init();
        await repo.init();
    });

    test("writePatchCommit creates a ref pointing at a commit", async () => {
        const repo = new StoreRepo(storeDir);
        await repo.init();
        const sha = await repo.writePatchCommit({
            ref: "refs/stashes/abc/v1",
            files: { "a.ts": "console.log(1);\n" },
            message: "stash:test v1",
        });
        expect(sha).toMatch(/^[a-f0-9]{40}$/);
        const resolved = await repo.resolveRef("refs/stashes/abc/v1");
        expect(resolved).toBe(sha);
    });

    test("writePatchCommit handles nested paths (subdirectory files)", async () => {
        // Regression: previous mktree-based impl rejected paths containing `/`
        // ("fatal: path src/foo.ts contains slash"). The write-tree-via-index path must accept them.
        const repo = new StoreRepo(storeDir);
        await repo.init();
        const sha = await repo.writePatchCommit({
            ref: "refs/stashes/nested/v1",
            files: {
                "PATCH.diff": "--- a/src/a.ts\n+++ b/src/a.ts\n",
                "src/a.ts": "export const a = 1;\n",
                "deep/nested/path/b.ts": "export const b = 2;\n",
            },
            message: "stash:nested v1",
        });
        expect(sha).toMatch(/^[a-f0-9]{40}$/);
        const a = await repo.readFileAt("refs/stashes/nested/v1", "src/a.ts");
        expect(a).toBe("export const a = 1;\n");
        const b = await repo.readFileAt("refs/stashes/nested/v1", "deep/nested/path/b.ts");
        expect(b).toBe("export const b = 2;\n");
    });

    test("deleteRef is missing-safe", async () => {
        const repo = new StoreRepo(storeDir);
        await repo.init();
        // Should not throw on a never-existed ref (drop loop must survive partial prior runs).
        await repo.deleteRef("refs/stashes/does-not-exist/v1");
    });
});
