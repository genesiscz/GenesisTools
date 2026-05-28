import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { resolveTaskSessionListingMeta } from "./task-session-listing-meta";

describe("resolveTaskSessionListingMeta", () => {
    let scratchDir: string | undefined;

    afterEach(() => {
        if (scratchDir) {
            rmSync(scratchDir, { recursive: true, force: true });
            scratchDir = undefined;
        }
    });

    it("falls back to jsonl meta line when meta file is missing", async () => {
        scratchDir = mkdtempSync(join(tmpdir(), "gt-task-listing-meta-"));

        const name = `jsonl-only-${Date.now()}`;
        const jsonlPath = join(scratchDir, `${name}.jsonl`);

        writeFileSync(
            jsonlPath,
            `${SafeJSON.stringify({
                type: "meta",
                session: name,
                command: "yarn dev",
                mode: "pipe",
                cwd: "/Users/dev/project",
                startedAt: new Date().toISOString(),
            })}\n`
        );

        const listing = await resolveTaskSessionListingMeta({
            store: new TaskSessionStore(),
            name,
            jsonlPath,
        });

        expect(listing.command).toBe("yarn dev");
        expect(listing.cwd).toBe("/Users/dev/project");
    });
});
