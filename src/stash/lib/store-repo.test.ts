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
});
