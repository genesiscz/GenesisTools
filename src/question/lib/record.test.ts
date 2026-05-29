import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { recordAnswer } from "./record";

describe("recordAnswer", () => {
    it("appends a resolved entry and returns its id", async () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-rec-"));
        const res = await recordAnswer(
            { question: "why bun?", answer: "fast + native sqlite", tag: "question", source: "cli" },
            {
                logBase,
                env: { CLAUDE_CODE_SESSION_ID: "sess-9", CLAUDECODE: "1" },
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        );
        expect(res.id).toMatch(/.+/);
        const file = join(logBase, readdirSync(logBase)[0]);
        const row = SafeJSON.parse(readFileSync(file, "utf8").trim()) as {
            question: string;
            sessionId: string;
            project: string;
            agent: string;
        };
        expect(row.question).toBe("why bun?");
        expect(row.sessionId).toBe("sess-9");
        expect(row.project.length).toBeGreaterThan(0);
        expect(row.agent).toBe("claude-code");
    });

    it("rejects empty question/answer", async () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-rec-"));
        await expect(
            recordAnswer(
                { question: " ", answer: "x", tag: "question", source: "cli" },
                { logBase, config: { sinks: { obsidian: false, sound: false, notify: false } } }
            )
        ).rejects.toThrow(/question/i);
    });
});
