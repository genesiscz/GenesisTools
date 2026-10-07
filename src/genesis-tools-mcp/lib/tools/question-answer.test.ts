import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRgbaToPng } from "@genesiscz/utils/image/raster";
import { SafeJSON } from "@genesiscz/utils/json";
import { handleQuestionAnswer, QUESTION_ANSWER_INPUT_SCHEMA } from "./question-answer";

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

describe("question_answer images", () => {
    it("advertises the optional image format and returns durable paths from the handler", async () => {
        expect(QUESTION_ANSWER_INPUT_SCHEMA.properties.attachments.items.required).toEqual(["type", "path"]);
        expect(QUESTION_ANSWER_INPUT_SCHEMA.required).toEqual(["question", "answer", "tag"]);
        const root = mkdtempSync(join(tmpdir(), "qa-mcp-images-"));
        const source = join(root, "shot.png");
        writeFileSync(source, encodeRgbaToPng(new Uint8ClampedArray([30, 60, 90, 255]), 1, 1));
        const result = await handleQuestionAnswer(
            {
                question: "Is this fixed?",
                answer: "Here is the result.",
                tag: "question",
                attachments: [{ type: "image", path: source, label: "Result" }],
            },
            {
                logBase: join(root, "log"),
                attachmentsRoot: join(root, "durable"),
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        );
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0].path).toStartWith(join(root, "durable"));
        expect(result.attachments[0].path).not.toBe(source);
        expect(result.attachments[0].label).toBe("Result");
    });
});
