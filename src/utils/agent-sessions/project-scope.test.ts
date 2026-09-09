import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createNativeHistoryAdapter } from "./native-adapter";

for (const summaryOnly of [true, false]) {
    test(`active Claude search includes encoded project worktrees with summaryOnly=${summaryOnly}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "history-project-scope-"));
        const fixtures = [
            ["-projects-shop", "11111111-2222-4333-8444-555555555551"],
            ["-projects-shop-worktree", "11111111-2222-4333-8444-555555555552"],
            ["-projects-shopping", "11111111-2222-4333-8444-555555555553"],
        ];
        for (const [project, id] of fixtures) {
            mkdirSync(join(root, project));
            writeFileSync(
                join(root, project, `${id}.jsonl`),
                `${SafeJSON.stringify({ type: "user", sessionId: id, cwd: "/projects/shop", timestamp: "2026-09-01T00:00:00Z", message: { content: "invoice fixture" } })}\n`
            );
        }
        const database = new Database(":memory:");
        try {
            const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [root], database });
            const found = await adapter.search({ project: "-projects-shop", query: "invoice", summaryOnly });
            expect(found.map((row) => row.sessionId).sort()).toEqual([fixtures[0][1], fixtures[1][1]]);
            const listed = await adapter.list({ project: "-projects-shop" });
            expect(listed.map((row) => row.sessionId).sort()).toEqual([fixtures[0][1], fixtures[1][1]]);
        } finally {
            database.close();
        }
    });
}
