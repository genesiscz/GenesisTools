import { describe, expect, it } from "bun:test";
import { shouldTranslateChatRequest } from "@app/ai-proxy/lib/translators/index";

describe("shouldTranslateChatRequest", () => {
    it("skips responses translation for grok subscription passthrough", () => {
        const req = new Request("http://127.0.0.1/v1/chat/completions", {
            headers: { "User-Agent": "Cursor/1.0" },
        });

        expect(
            shouldTranslateChatRequest({
                mode: "auto",
                req,
                bodyText: '{"messages":[{"role":"user","content":"hi"}]}',
                providerId: "grok-subscription",
            })
        ).toBe(false);
    });

    it("still translates copilot subscription for Cursor", () => {
        const req = new Request("http://127.0.0.1/v1/chat/completions", {
            headers: { "User-Agent": "Cursor/1.0" },
        });

        expect(
            shouldTranslateChatRequest({
                mode: "auto",
                req,
                bodyText: '{"messages":[{"role":"user","content":"hi"}]}',
                providerId: "github-copilot-subscription",
            })
        ).toBe(true);
    });
});
