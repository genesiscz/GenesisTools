import { describe, expect, it } from "bun:test";
import { normalizeGrokTool, prepareGrokUpstreamBody } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { SafeJSON } from "@app/utils/json";

describe("rewrite-upstream-body", () => {
    it("replaces proxy model id with upstream id in JSON body", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "genesiscz/grok/grok-composer-2.5-fast",
                messages: [{ role: "user", content: "hi" }],
            }),
            "grok-composer-2.5-fast"
        );

        const parsed = SafeJSON.parse(rewritten) as { model: string };
        expect(parsed.model).toBe("grok-composer-2.5-fast");
    });

    it("flattens OpenAI nested function tools for Grok responses API", () => {
        const normalized = normalizeGrokTool({
            type: "function",
            function: {
                name: "Read",
                description: "Read a file",
                parameters: { type: "object", properties: {} },
            },
        });

        expect(normalized?.name).toBe("Read");
        expect(normalized?.type).toBe("function");
    });

    it("converts custom Cursor tools to function tools", () => {
        const normalized = normalizeGrokTool({
            type: "custom",
            name: "ApplyPatch",
            format: { type: "grammar", syntax: "lark" },
        });

        expect(normalized?.type).toBe("function");
        expect(normalized?.name).toBe("ApplyPatch");
    });

    it("prepares agent body with normalized tools", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "genesiscz/grok/grok-composer-2.5-fast",
                input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
                tools: [
                    {
                        type: "function",
                        function: { name: "Read", description: "Read", parameters: { type: "object" } },
                    },
                    { type: "custom", name: "ApplyPatch", format: { type: "grammar" } },
                ],
            }),
            "grok-composer-2.5-fast"
        );

        const parsed = SafeJSON.parse(rewritten) as { tools: Array<{ type: string; name: string }> };
        expect(parsed.tools).toHaveLength(2);
        expect(parsed.tools.every((tool) => tool.type === "function" && typeof tool.name === "string")).toBe(true);
    });
});
