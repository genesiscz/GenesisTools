import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { SafeJSON } from "@app/utils/json";
import { resolveTaskSessionListingMeta } from "./task-session-listing-meta";

describe("resolveTaskSessionListingMeta", () => {
    it("falls back to jsonl meta line when meta file is missing", async () => {
        const dir = join(import.meta.dir, ".tmp-task-listing-meta");
        mkdirSync(dir, { recursive: true });

        const name = `jsonl-only-${Date.now()}`;
        const jsonlPath = join(dir, `${name}.jsonl`);

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
