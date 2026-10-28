import { describe, expect, it } from "bun:test";
import { providerTypes } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { identityPipeline } from "@app/ai-proxy/lib/translators/identity-pipeline";
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

    it("skips responses translation for openrouter, which has no Responses upstream", () => {
        const req = new Request("http://127.0.0.1/v1/chat/completions", {
            headers: { "User-Agent": "Cursor/1.0" },
        });

        expect(
            shouldTranslateChatRequest({
                mode: "auto",
                req,
                bodyText: '{"messages":[{"role":"user","content":"hi"}]}',
                providerId: "openrouter",
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

describe("the chat path per provider type", () => {
    const chatBody = '{"messages":[{"role":"user","content":"hi"}]}';

    function perProvider<T>(answer: (provider: string) => T): Record<string, T> {
        return Object.fromEntries(providerTypes().map((provider) => [provider, answer(provider)]));
    }

    it("sends a Cursor chat request through the Responses translation except where chat completions is the only path", () => {
        const req = () => new Request("http://127.0.0.1/v1/chat/completions");
        const answers: Record<string, boolean> = {
            ...perProvider((providerId) =>
                shouldTranslateChatRequest({ mode: "on", req: req(), bodyText: chatBody, providerId })
            ),
            unknown: shouldTranslateChatRequest({ mode: "on", req: req(), bodyText: chatBody, providerId: "pigeon" }),
            none: shouldTranslateChatRequest({ mode: "on", req: req(), bodyText: chatBody }),
        };

        expect(answers).toEqual({
            "grok-subscription": false,
            "github-copilot-subscription": true,
            "anthropic-subscription": false,
            "openai-subscription": true,
            "xai-api-key": true,
            openai: true,
            openrouter: false,
            unknown: true,
            none: true,
        });
    });

    it("reshapes the chat answer for the client only for the providers that need it", async () => {
        const provider = (id: string): ProxyProvider => ({
            id,
            accountFingerprint: "test",
            listModels: async () => [],
            chatCompletions: async () =>
                new Response('{"id":"c1","model":"upstream","choices":[]}', {
                    headers: { "Content-Type": "application/json", etag: '"fixture"' },
                }),
            responses: async () => {
                throw new Error("not used");
            },
            getUsage: async () => {
                throw new Error("not used");
            },
        });
        const enriched = async (id: string) => {
            const result = await identityPipeline({
                provider: provider(id),
                upstreamModel: "upstream",
                proxyModel: "work/slug/proxy-model",
                path: "chat/completions",
                req: new Request("http://127.0.0.1/v1/chat/completions"),
                bodyText: chatBody,
            });

            return result.response.headers.get("etag") === null;
        };
        const answers: Record<string, boolean> = {};

        for (const id of [...providerTypes(), "pigeon"]) {
            answers[id] = await enriched(id);
        }

        expect(answers).toEqual({
            "grok-subscription": true,
            "github-copilot-subscription": false,
            "anthropic-subscription": false,
            "openai-subscription": false,
            "xai-api-key": false,
            openai: false,
            openrouter: true,
            pigeon: false,
        });
    });
});
