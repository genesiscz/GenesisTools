import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { openHistoryService } from "./open-service";

test("shared Claude search matches query and file filters inside Bash tool input", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-claude-shared-search-"));
    const project = join(root, "-projects-shop");
    const sessionId = "11111111-2222-4333-8444-555555555555";
    mkdirSync(project);
    writeFileSync(
        join(project, `${sessionId}.jsonl`),
        `${SafeJSON.stringify(
            {
                type: "assistant",
                sessionId,
                timestamp: "2026-09-01T10:00:00.000Z",
                cwd: "/projects/shop",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "call-1",
                            name: "Bash",
                            input: { command: "ls /repo/.vitrinka/config.json" },
                        },
                    ],
                },
            },
            { strict: true }
        )}\n`
    );
    const database = new Database(":memory:");

    try {
        const response = await openHistoryService({ provider: "claude", roots: [root], database }).search({
            query: ".vitrinka/",
            file: ".vitrinka",
        });

        expect(response.results.map((result) => result.session.sessionId)).toEqual([sessionId]);
        expect(response.results[0]?.matchedEntries[0]?.inputText).toContain("/repo/.vitrinka/config.json");
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});
