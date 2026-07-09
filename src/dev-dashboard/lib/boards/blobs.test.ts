import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@app/utils/env";
import { blobPath, putBlob } from "./blobs";

describe("blob store", () => {
    let dir = "";

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "boards-blob-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
    });

    it("writes a blob and returns a 64-hex key with the mime's extension", async () => {
        const data = new Uint8Array([1, 2, 3, 4]);
        const key = await putBlob(data, "image/png");
        expect(key).toMatch(/^[0-9a-f]{64}\.png$/);
    });

    it("is idempotent — the same bytes produce the same key", async () => {
        const data = new Uint8Array([9, 8, 7, 6, 5]);
        const key1 = await putBlob(data, "image/jpeg");
        const key2 = await putBlob(data, "image/jpeg");
        expect(key1).toBe(key2);
    });

    it("blobPath resolves a written key to an existing file", async () => {
        const data = new Uint8Array([42]);
        const key = await putBlob(data, "image/png");
        const path = blobPath(key);
        expect(path).not.toBeNull();
        expect(path).toContain(key);
    });

    it("blobPath returns null for traversal or unknown keys", () => {
        expect(blobPath("../etc/passwd")).toBeNull();
        expect(blobPath("nope.png")).toBeNull();
    });
});
