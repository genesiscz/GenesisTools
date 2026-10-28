import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { readClientLedger, setClientLedgerDirForTests } from "@app/ai-proxy/lib/usage/client-ledger";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { resolveAnthropicSubModel } from "@genesiscz/utils/ai/anthropic/models";
import { SafeJSON } from "@genesiscz/utils/json";

const recordUsageRequest = mock((_record: UsageRequestRecord) => {});

// Spread the real module: the provider registry, which books an alias as its model, reaches the store's other exports.
const realStore = await import("@app/ai-proxy/lib/usage/store");

mock.module("@app/ai-proxy/lib/usage/store", () => ({
    ...realStore,
    recordUsageRequest,
}));

const { trackCompletedRequest } = await import("@app/ai-proxy/lib/usage/track-response");

const account: AiProxyAccountConfig = {
    name: "genesiscz",
    provider: "grok-subscription",
    providerSlug: "grok",
    enabled: true,
};

const route = {
    accountName: "genesiscz",
    providerSlug: "grok",
    upstreamId: "grok-composer-2.5-fast",
    account,
};

let ledgerTempDir: string;

beforeEach(() => {
    ledgerTempDir = mkdtempSync(join(tmpdir(), "track-response-ledger-"));
    setClientLedgerDirForTests(ledgerTempDir);
});

afterEach(() => {
    setClientLedgerDirForTests(null);
    rmSync(ledgerTempDir, { recursive: true, force: true });
});

describe("trackCompletedRequest", () => {
    beforeEach(() => {
        recordUsageRequest.mockClear();
    });

    it("records usage from JSON response bodies", () => {
        const responseBody = SafeJSON.stringify({
            usage: { prompt_tokens: 84, completion_tokens: 21, total_tokens: 105 },
        });

        trackCompletedRequest({
            route,
            client: "alice",
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
            path: "/v1/chat/completions",
            status: 200,
            elapsedMs: 12400,
            bodyText: SafeJSON.stringify({ model: "genesiscz/grok/grok-composer-2.5-fast", stream: false }),
            responseBody,
            translate: "auto",
            thinking: "raw",
        });

        expect(recordUsageRequest).toHaveBeenCalledTimes(1);
        const record = recordUsageRequest.mock.calls[0][0] as UsageRequestRecord;

        expect(record.account).toBe("genesiscz");
        expect(record.provider).toBe("grok-subscription");
        expect(record.proxyModel).toBe("genesiscz/grok/grok-composer-2.5-fast");
        expect(record.upstreamModel).toBe("grok-composer-2.5-fast");
        expect(record.path).toBe("/v1/chat/completions");
        expect(record.status).toBe(200);
        expect(record.elapsedMs).toBe(12400);
        expect(record.stream).toBe(false);
        expect(record.translate).toBe("auto");
        expect(record.thinking).toBe("raw");
        expect(record.usage).toEqual({
            prompt_tokens: 84,
            completion_tokens: 21,
            total_tokens: 105,
        });
        expect(record.rateLimited).toBe(false);
        expect(record.error).toBe(false);
        expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(record.client).toBe("alice");

        const monthKey = record.ts.slice(0, 7);
        expect(readClientLedger().months[monthKey]?.alice?.requests).toBe(1);
    });

    it("records usage from translated SSE buffers", () => {
        const responseBody = [
            'data: {"choices":[{"delta":{"content":"hi"}}]}',
            "",
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
            "",
            "data: [DONE]",
            "",
        ].join("\n");

        trackCompletedRequest({
            route,
            client: "alice",
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
            path: "/v1/chat/completions",
            status: 200,
            elapsedMs: 900,
            bodyText: SafeJSON.stringify({ model: "genesiscz/grok/grok-composer-2.5-fast", stream: true }),
            responseBody,
            translate: "on",
            thinking: "cursor",
        });

        const record = recordUsageRequest.mock.calls[0][0] as UsageRequestRecord;

        expect(record.stream).toBe(true);
        expect(record.thinking).toBe("cursor");
        expect(record.usage).toEqual({
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
        });
    });

    it("flags rate limits and errors from status codes", () => {
        trackCompletedRequest({
            route,
            client: "alice",
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
            path: "/v1/responses",
            status: 429,
            elapsedMs: 50,
            bodyText: SafeJSON.stringify({ model: "genesiscz/grok/grok-composer-2.5-fast" }),
            responseBody: SafeJSON.stringify({ error: { message: "rate limited" } }),
            translate: "off",
        });

        const rateLimited = recordUsageRequest.mock.calls[0][0] as UsageRequestRecord;
        expect(rateLimited.rateLimited).toBe(true);
        expect(rateLimited.error).toBe(true);

        recordUsageRequest.mockClear();

        trackCompletedRequest({
            route,
            client: "alice",
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
            path: "/v1/chat/completions",
            status: 500,
            elapsedMs: 80,
            bodyText: SafeJSON.stringify({ model: "genesiscz/grok/grok-composer-2.5-fast" }),
            responseBody: SafeJSON.stringify({ error: { message: "upstream error" } }),
        });

        const errored = recordUsageRequest.mock.calls[0][0] as UsageRequestRecord;
        expect(errored.rateLimited).toBe(false);
        expect(errored.error).toBe(true);
    });

    it("records a row for an exchange that never completed, so aborted calls stay visible", () => {
        recordUsageRequest.mockClear();

        trackCompletedRequest({
            route,
            client: "alice",
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
            path: "/v1/chat/completions",
            // headers said 200 — the stream died afterwards
            status: 200,
            elapsedMs: 1200,
            bodyText: SafeJSON.stringify({ model: "genesiscz/grok/grok-composer-2.5-fast", stream: true }),
            responseBody: "",
            failure: "The socket connection was closed unexpectedly",
        });

        const dropped = recordUsageRequest.mock.calls[0][0] as UsageRequestRecord;
        expect(dropped.error).toBe(true);
        expect(dropped.failure).toContain("socket connection was closed");
        expect(dropped.status).toBe(200);
    });

    it("books a Claude subscription alias as its concrete model, and another provider's id as it was sent", () => {
        recordUsageRequest.mockClear();

        for (const [provider, upstreamId] of [
            ["anthropic-subscription", "sonnet"],
            ["openai-subscription", "sol"],
        ] as const) {
            trackCompletedRequest({
                route: {
                    accountName: "work",
                    providerSlug: "slug",
                    upstreamId,
                    account: { name: "work", provider, providerSlug: "slug", enabled: true },
                },
                client: "alice",
                proxyModel: `work/slug/${upstreamId}`,
                path: "/v1/messages",
                status: 200,
                elapsedMs: 10,
                bodyText: SafeJSON.stringify({ model: `work/slug/${upstreamId}`, stream: false }),
                responseBody: SafeJSON.stringify({
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
            });
        }

        const booked = recordUsageRequest.mock.calls.map(([record]) => (record as UsageRequestRecord).upstreamModel);
        expect(booked).toEqual([resolveAnthropicSubModel("sonnet"), "sol"]);
        expect(booked[0]).toStartWith("claude-sonnet-");
    });
});
