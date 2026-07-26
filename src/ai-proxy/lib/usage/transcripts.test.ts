import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseResponseBody, readRequestTags, transcriptFile } from "./transcripts";

function sse(frames: object[]): string {
    return `${frames.map((frame) => `data: ${SafeJSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

describe("parseResponseBody", () => {
    it("returns empty text and thinking for an empty body", () => {
        expect(parseResponseBody("", false)).toEqual({ text: "", thinking: "" });
        expect(parseResponseBody("   \n", true)).toEqual({ text: "", thinking: "" });
    });

    it("reads text, reasoning, usage and finish reason off a plain JSON reply", () => {
        const body = SafeJSON.stringify({
            choices: [
                {
                    message: { content: "answer", reasoning_content: "because" },
                    finish_reason: "stop",
                },
            ],
            usage: { total_tokens: 7 },
        });

        const parsed = parseResponseBody(body, false);
        expect(parsed.text).toBe("answer");
        expect(parsed.thinking).toBe("because");
        expect(parsed.finishReason).toBe("stop");
        expect(parsed.usage).toEqual({ total_tokens: 7 });
    });

    it("reassembles a streamed reply across frames, keeping thinking separate from text", () => {
        const body = sse([
            { choices: [{ delta: { reasoning_content: "think " } }] },
            { choices: [{ delta: { reasoning_content: "harder" } }] },
            { choices: [{ delta: { content: "one " } }] },
            { choices: [{ delta: { content: "two" }, finish_reason: "stop" }] },
        ]);

        const parsed = parseResponseBody(body, true);
        expect(parsed.text).toBe("one two");
        expect(parsed.thinking).toBe("think harder");
        expect(parsed.finishReason).toBe("stop");
    });

    it("collects tool calls out of a stream", () => {
        const body = sse([
            { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "grep" } }] } }] },
            { choices: [{ delta: { content: "done" }, finish_reason: "tool_calls" }] },
        ]);

        const parsed = parseResponseBody(body, true);
        expect(parsed.toolCalls).toHaveLength(1);
        expect(parsed.toolCalls?.[0]?.function?.name).toBe("grep");
    });

    it("keeps a non-JSON body as text instead of throwing it away", () => {
        expect(parseResponseBody("<html>gateway timeout</html>", false)).toEqual({
            text: "<html>gateway timeout</html>",
            thinking: "",
        });
    });

    it("skips unparseable frames but keeps the good ones", () => {
        const body = `data: {"choices":[{"delta":{"content":"kept"}}]}\n\ndata: {oops\n\ndata: [DONE]\n\n`;
        expect(parseResponseBody(body, true).text).toBe("kept");
    });
});

describe("readRequestTags", () => {
    it("returns undefined when no x-gt-* header is present", () => {
        expect(readRequestTags(new Headers({ "content-type": "application/json" }))).toBeUndefined();
    });

    it("reads the tags that are present and leaves the rest undefined", () => {
        const tags = readRequestTags(new Headers({ "x-gt-session": "run-7", "x-gt-stage": "filter" }));

        expect(tags?.session).toBe("run-7");
        expect(tags?.stage).toBe("filter");
        expect(tags?.run).toBeUndefined();
        expect(tags?.label).toBeUndefined();
    });
});

describe("transcriptFile", () => {
    it("names the file after the session", () => {
        expect(transcriptFile("2026-07-25", "lff-mine")).toEndWith("/2026-07-25/lff-mine.jsonl");
    });

    it("falls back to _untagged and strips path separators out of a session name", () => {
        expect(transcriptFile("2026-07-25")).toEndWith("/2026-07-25/_untagged.jsonl");
        // A session name can never escape the day directory: separators collapse to dashes.
        expect(transcriptFile("2026-07-25", "../../etc/passwd")).toEndWith("/2026-07-25/..-..-etc-passwd.jsonl");
    });
});
