import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { handleQuestionAnswer } from "./question-answer";

describe("question_answer handler", () => {
    it("records and returns a structured summary with source=mcp", async () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-mcp-"));
        const r = await handleQuestionAnswer(
            { question: "why sqlite read-model?", answer: "fast read-after-write", tag: "question" },
            {
                logBase,
                env: { CLAUDE_CODE_SESSION_ID: "s", CLAUDECODE: "1" },
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        );
        expect(r.id).toMatch(/.+/);
        expect(r.summary).toContain(r.id);
        const f = join(logBase, readdirSync(logBase)[0]);
        const row = SafeJSON.parse(readFileSync(f, "utf8").trim()) as { source: string };
        expect(row.source).toBe("mcp");
    });
});
