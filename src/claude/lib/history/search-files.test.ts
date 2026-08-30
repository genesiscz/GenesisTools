import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { searchConversationFiles } from "./search";

function jsonl(obj: Record<string, unknown>): string {
    return `${SafeJSON.stringify(obj)}\n`;
}

describe("searchConversationFiles", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "hist-search-"));
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("finds a session whose only hit is a Write file_path", async () => {
        const hitId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
        const missId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
        const hitPath = join(tmpDir, `${hitId}.jsonl`);
        const missPath = join(tmpDir, `${missId}.jsonl`);

        writeFileSync(
            hitPath,
            jsonl({
                type: "assistant",
                sessionId: hitId,
                timestamp: "2026-08-28T12:00:00.000Z",
                gitBranch: "feat/vitrinka",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "Write",
                            input: { file_path: "/repo/.vitrinka/config.json", content: "{}" },
                        },
                    ],
                },
            })
        );
        writeFileSync(
            missPath,
            jsonl({
                type: "user",
                sessionId: missId,
                timestamp: "2026-08-28T12:00:00.000Z",
                message: { role: "user", content: "hello world" },
            })
        );

        const results = await searchConversationFiles([hitPath, missPath], { query: ".vitrinka/" });

        expect(results.map((r) => r.sessionId)).toEqual([hitId]);
    });

    it("matches --file against a Bash command path, not only Write file_path", async () => {
        const sessionId = "cccccccc-3333-4333-8333-cccccccccccc";
        const filePath = join(tmpDir, `${sessionId}.jsonl`);

        writeFileSync(
            filePath,
            jsonl({
                type: "assistant",
                sessionId,
                timestamp: "2026-08-28T12:00:00.000Z",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "Bash",
                            input: { command: "ls /repo/.vitrinka/config.json" },
                        },
                    ],
                },
            })
        );

        const results = await searchConversationFiles([filePath], { file: ".vitrinka" });

        expect(results.map((r) => r.sessionId)).toEqual([sessionId]);
    });

    it("stops after the first matching session when stopAfter is 1", async () => {
        const firstId = "dddddddd-4444-4444-8444-dddddddddddd";
        const secondId = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
        const firstPath = join(tmpDir, `${firstId}.jsonl`);
        const secondPath = join(tmpDir, `${secondId}.jsonl`);

        for (const [id, path] of [
            [firstId, firstPath],
            [secondId, secondPath],
        ] as const) {
            writeFileSync(
                path,
                jsonl({
                    type: "user",
                    sessionId: id,
                    timestamp: "2026-08-28T12:00:00.000Z",
                    message: { role: "user", content: "needle-token" },
                })
            );
        }

        const results = await searchConversationFiles(
            [firstPath, secondPath],
            { query: "needle-token" },
            { stopAfter: 1 }
        );

        expect(results.map((r) => r.sessionId)).toEqual([firstId]);
    });
});
