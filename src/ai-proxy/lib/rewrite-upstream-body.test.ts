import { describe, expect, it } from "bun:test";
import {
    findInvalidImageDataPayload,
    GROK_IMAGE_FALLBACK_MODEL,
    grokModelSupportsImages,
    latestUserTurnHasImages,
    normalizeGrokTool,
    normalizeGrokToolForChat,
    prepareGrokUpstreamBody,
    requestHasImageContent,
    resolveGrokUpstreamModelForImages,
} from "@app/ai-proxy/lib/rewrite-upstream-body";
import { SafeJSON } from "@genesiscz/utils/json";

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

describe("findInvalidImageDataPayload", () => {
    it("catches a stringified-object payload in chat messages", () => {
        // ai@7 + @ai-sdk/openai v2 compat mode stringifies V4 tagged file data
        // into "[object Object]" — the exact request shape eve sent.
        const payload = findInvalidImageDataPayload({
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "What do you see?" },
                        { type: "image_url", image_url: { url: "data:image/jpeg;base64,[object Object]" } },
                    ],
                },
            ],
        });

        expect(payload).toBe("[object Object]");
    });

    it("catches invalid payloads in responses input items", () => {
        const payload = findInvalidImageDataPayload({
            input: [
                {
                    role: "user",
                    content: [{ type: "input_image", image_url: "data:image/png;base64,not valid!" }],
                },
            ],
        });

        expect(payload).toBe("not valid!");
    });

    it("catches empty base64 payloads", () => {
        const payload = findInvalidImageDataPayload({
            messages: [
                { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," } }] },
            ],
        });

        expect(payload).toBe("");
    });

    it("accepts valid base64 payloads", () => {
        const payload = findInvalidImageDataPayload({
            messages: [
                {
                    role: "user",
                    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }],
                },
            ],
        });

        expect(payload).toBeNull();
    });

    it("ignores remote URLs and non-base64 data URLs", () => {
        const payload = findInvalidImageDataPayload({
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
                        { type: "image_url", image_url: { url: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E" } },
                    ],
                },
            ],
        });

        expect(payload).toBeNull();
    });

    it("ignores bodies without image parts", () => {
        expect(findInvalidImageDataPayload({ messages: [{ role: "user", content: "hi" }] })).toBeNull();
    });

    it("catches stringified-object data inside AI SDK file parts", () => {
        const payload = findInvalidImageDataPayload({
            messages: [
                {
                    role: "user",
                    content: [{ type: "file", mediaType: "image/jpeg", data: "[object Object]" }],
                },
            ],
        });

        expect(payload).toBe("[object Object]");
    });
});

describe("AI SDK image part variants", () => {
    const JPEG_B64 = "/9j/4AAQSkZJRg==";

    function firstContentPart(bodyText: string): Record<string, unknown> {
        const parsed = SafeJSON.parse(bodyText) as {
            messages: Array<{ content: Array<Record<string, unknown>> }>;
        };
        const part = parsed.messages[0]?.content?.[0];
        if (!part) {
            throw new Error("no content part");
        }
        return part;
    }

    it("routes and normalizes image_url string form", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-4.3",
                messages: [
                    { role: "user", content: [{ type: "image_url", image_url: `data:image/jpeg;base64,${JPEG_B64}` }] },
                ],
            }),
            "grok-4.3",
            "chat"
        );

        expect(rewritten.imageRouted).toBe(true);
        expect(rewritten.upstreamModel).toBe(GROK_IMAGE_FALLBACK_MODEL);
        expect(firstContentPart(rewritten.bodyText)).toEqual({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` },
        });
    });

    it("routes and normalizes input_image parts", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-4.3",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "input_image", image_url: `data:image/png;base64,${JPEG_B64}` }],
                    },
                ],
            }),
            "grok-4.3",
            "chat"
        );

        expect(rewritten.imageRouted).toBe(true);
        expect(firstContentPart(rewritten.bodyText)).toEqual({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${JPEG_B64}` },
        });
    });

    it("routes and normalizes file parts with image mediaType and raw base64", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-4.3",
                messages: [{ role: "user", content: [{ type: "file", mediaType: "image/jpeg", data: JPEG_B64 }] }],
            }),
            "grok-4.3",
            "chat"
        );

        expect(rewritten.imageRouted).toBe(true);
        expect(firstContentPart(rewritten.bodyText)).toEqual({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` },
        });
    });

    it("routes and normalizes file parts with a data URL and no mediaType", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-4.3",
                messages: [{ role: "user", content: [{ type: "file", data: `data:image/jpeg;base64,${JPEG_B64}` }] }],
            }),
            "grok-4.3",
            "chat"
        );

        expect(rewritten.imageRouted).toBe(true);
        expect(firstContentPart(rewritten.bodyText)).toEqual({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` },
        });
    });

    it("recovers ai@7 V4 tagged file data serialized to JSON", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-4.3",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "file", mediaType: "image/jpeg", data: { type: "data", data: JPEG_B64 } }],
                    },
                ],
            }),
            "grok-4.3",
            "chat"
        );

        expect(rewritten.imageRouted).toBe(true);
        expect(firstContentPart(rewritten.bodyText)).toEqual({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` },
        });
    });

    it("routes and normalizes AI SDK core image parts (image field, raw base64)", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-4.3",
                messages: [{ role: "user", content: [{ type: "image", image: JPEG_B64 }] }],
            }),
            "grok-4.3",
            "chat"
        );

        expect(rewritten.imageRouted).toBe(true);
        expect(firstContentPart(rewritten.bodyText)).toEqual({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` },
        });
    });

    it("leaves non-image file parts untouched and unrouted", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "martin/grok/grok-4.3",
                messages: [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: JPEG_B64 }] }],
            }),
            "grok-4.3",
            "chat"
        );

        expect(rewritten.imageRouted).toBe(false);
        expect(rewritten.upstreamModel).toBe("grok-4.3");
        expect(firstContentPart(rewritten.bodyText)).toEqual({
            type: "file",
            mediaType: "application/pdf",
            data: JPEG_B64,
        });
    });
});
