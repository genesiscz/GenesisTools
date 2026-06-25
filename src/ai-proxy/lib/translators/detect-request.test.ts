import { describe, expect, it } from "bun:test";
import { detectCursorRequest, isResponsesShapedBody } from "@app/ai-proxy/lib/translators/detect-request";
import { SafeJSON } from "@app/utils/json";

describe("detect-request", () => {
    it("detects responses-shaped body on chat path", () => {
        expect(isResponsesShapedBody({ model: "x", input: "hi" })).toBe(true);
        expect(isResponsesShapedBody({ model: "x", messages: [{ role: "user", content: "hi" }] })).toBe(false);
    });

    it("detects Cursor user agent even when body JSON is malformed", () => {
        const req = new Request("http://127.0.0.1/v1/chat/completions", {
            headers: { "User-Agent": "Cursor/1.0" },
        });

        expect(detectCursorRequest(req, "{not-json")).toBe(true);
    });

    it("detects responses-shaped body without Cursor user agent", () => {
        const req = new Request("http://127.0.0.1/v1/chat/completions");
        const body = SafeJSON.stringify({ model: "x", input: "hi" });

        expect(detectCursorRequest(req, body)).toBe(true);
    });
});
