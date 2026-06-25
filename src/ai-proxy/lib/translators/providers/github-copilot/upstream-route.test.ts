import { describe, expect, it } from "bun:test";
import {
    needsCopilotResponsesApi,
    resolveCopilotUpstreamRoute,
} from "@app/ai-proxy/lib/translators/providers/github-copilot/upstream-route";

describe("copilot upstream-route", () => {
    it("routes GPT-5.2+ models to responses API", () => {
        expect(needsCopilotResponsesApi("gpt-5.2")).toBe(true);
        expect(resolveCopilotUpstreamRoute("gpt-5.2", { messages: [] })).toEqual({
            api: "responses",
            path: "/responses",
        });
    });

    it("routes anthropic-shaped bodies to messages API", () => {
        expect(
            resolveCopilotUpstreamRoute("claude-sonnet-4", {
                system: "You are helpful",
                messages: [{ role: "user", content: "hi" }],
                max_tokens: 1024,
            })
        ).toEqual({
            api: "messages",
            path: "/v1/messages",
        });
    });

    it("defaults other models to chat completions", () => {
        expect(resolveCopilotUpstreamRoute("gpt-4o", { messages: [] })).toEqual({
            api: "chat",
            path: "/chat/completions",
        });
    });
});
