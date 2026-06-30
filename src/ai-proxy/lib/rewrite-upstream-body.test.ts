import { describe, expect, it } from "bun:test";
import {
    GROK_IMAGE_FALLBACK_MODEL,
    grokModelSupportsImages,
    latestUserTurnHasImages,
    normalizeGrokTool,
    normalizeGrokToolForChat,
    prepareGrokUpstreamBody,
    requestHasImageContent,
    resolveGrokUpstreamModelForImages,
} from "@app/ai-proxy/lib/rewrite-upstream-body";
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

        const parsed = SafeJSON.parse(rewritten.bodyText) as { model: string; enable_thinking?: boolean };
        expect(parsed.model).toBe("grok-composer-2.5-fast");
        expect(parsed.enable_thinking).toBe(true);
        expect(rewritten.imageRouted).toBe(false);
    });

    it("forces enable_thinking for grok-build reasoning models", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-build-0.1",
                messages: [{ role: "user", content: "hi" }],
            }),
            "grok-build-0.1"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as { model: string; enable_thinking?: boolean };
        expect(parsed.model).toBe("grok-build-0.1");
        expect(parsed.enable_thinking).toBe(true);
    });

    it("does not force enable_thinking for non-reasoning grok models", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "grok-code-fast",
                messages: [{ role: "user", content: "hi" }],
            }),
            "grok-code-fast"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as { enable_thinking?: boolean };
        expect(parsed.enable_thinking).toBeUndefined();
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

    it("keeps nested function tools for Grok chat completions API", () => {
        const normalized = normalizeGrokToolForChat({
            type: "function",
            function: {
                name: "Read",
                description: "Read a file",
                parameters: { type: "object", properties: {} },
            },
        });

        expect(normalized?.type).toBe("function");
        expect((normalized?.function as { name: string }).name).toBe("Read");
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

    it("prepares agent body with flattened tools for responses target", () => {
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
            "grok-composer-2.5-fast",
            "responses"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as { tools: Array<{ type: string; name: string }> };
        expect(parsed.tools).toHaveLength(2);
        expect(parsed.tools.every((tool) => tool.type === "function" && typeof tool.name === "string")).toBe(true);
    });

    it("prepares chat body with nested function tools for chat target", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "genesiscz/grok/grok-composer-2.5-fast",
                messages: [{ role: "user", content: "hi" }],
                tools: [
                    {
                        type: "function",
                        function: { name: "Read", description: "Read", parameters: { type: "object" } },
                    },
                    { type: "custom", name: "ApplyPatch", format: { type: "grammar" } },
                ],
            }),
            "grok-composer-2.5-fast",
            "chat"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as {
            tools: Array<{ type: string; function: { name: string } }>;
            max_tokens?: number;
            max_output_tokens?: number;
        };
        expect(parsed.tools).toHaveLength(2);
        expect(parsed.tools.every((tool) => tool.type === "function" && typeof tool.function?.name === "string")).toBe(
            true
        );
        expect(parsed.max_output_tokens).toBeUndefined();
    });

    it("detects image-capable grok models", () => {
        expect(grokModelSupportsImages("grok-2-vision")).toBe(true);
        expect(grokModelSupportsImages("grok-build")).toBe(true);
        expect(grokModelSupportsImages("grok-composer-2.5-fast")).toBe(false);
    });

    it("routes composer requests with images to grok-build", () => {
        const body = {
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "what is this" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
                    ],
                },
            ],
        };

        expect(requestHasImageContent(body)).toBe(true);
        expect(latestUserTurnHasImages(body)).toBe(true);
        expect(resolveGrokUpstreamModelForImages("grok-composer-2.5-fast", body)).toBe(GROK_IMAGE_FALLBACK_MODEL);

        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({ model: "x", ...body }),
            "grok-composer-2.5-fast",
            "chat"
        );
        const parsed = SafeJSON.parse(rewritten.bodyText) as {
            model: string;
            messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
        };

        expect(rewritten.upstreamModel).toBe(GROK_IMAGE_FALLBACK_MODEL);
        expect(parsed.model).toBe(GROK_IMAGE_FALLBACK_MODEL);
        expect(rewritten.imageRouted).toBe(true);
        expect(parsed.messages[0]?.content?.[1]?.type).toBe("image_url");
        expect(parsed.messages[0]?.content?.[1]?.image_url?.url).toContain("data:image/png");
    });

    it("follow-up turns stay on composer and replace historical images with text references", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "grok-composer-2.5-fast",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "what is this" },
                            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
                        ],
                    },
                    { role: "assistant", content: "It looks red." },
                    { role: "user", content: "thanks, now fix the bug" },
                ],
            }),
            "grok-composer-2.5-fast",
            "chat"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as {
            model: string;
            messages: Array<{ content: Array<{ type: string; text?: string }> | string }>;
        };

        expect(rewritten.upstreamModel).toBe("grok-composer-2.5-fast");
        expect(rewritten.imageRouted).toBe(false);
        expect(parsed.model).toBe("grok-composer-2.5-fast");

        const firstUserContent = parsed.messages[0]?.content;
        expect(Array.isArray(firstUserContent)).toBe(true);
        expect((firstUserContent as Array<{ type: string; text?: string }>)[1]?.type).toBe("text");
        expect((firstUserContent as Array<{ type: string; text?: string }>)[1]?.text).toContain("earlier turn");
    });

    it("keeps images only in the latest user turn when routing to grok-build", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "grok-composer-2.5-fast",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,old" } }],
                    },
                    { role: "assistant", content: "Red square." },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "and this one?" },
                            { type: "image_url", image_url: { url: "data:image/png;base64,new" } },
                        ],
                    },
                ],
            }),
            "grok-composer-2.5-fast",
            "chat"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as {
            messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
        };

        expect(rewritten.imageRouted).toBe(true);
        expect(parsed.messages[0]?.content?.[0]?.type).toBe("text");
        expect(parsed.messages[2]?.content?.[1]?.type).toBe("image_url");
        expect(parsed.messages[2]?.content?.[1]?.image_url?.url).toContain("new");
    });

    it("converts chat image_url to input_image for responses target", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "grok-composer-2.5-fast",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "what is this" },
                            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
                        ],
                    },
                ],
            }),
            "grok-composer-2.5-fast",
            "responses"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as {
            input: Array<{ content: Array<{ type: string; image_url?: string }> }>;
        };
        const imagePart = parsed.input[0]?.content?.[1];
        expect(imagePart?.type).toBe("input_image");
        expect(imagePart?.image_url).toBe("data:image/png;base64,abc");
    });

    it("keeps image parts on grok-build without rerouting", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "grok-build",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
                    },
                ],
            }),
            "grok-build",
            "chat"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as {
            model: string;
            messages: Array<{ content: Array<{ type: string }> }>;
        };
        expect(parsed.model).toBe("grok-build");
        expect(rewritten.imageRouted).toBe(false);
        expect(parsed.messages[0]?.content?.[0]?.type).toBe("image_url");
    });
});
