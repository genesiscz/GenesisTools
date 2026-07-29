import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordClientUsage, setClientLedgerDirForTests } from "@app/ai-proxy/lib/usage/client-ledger";
import { type ProxyUsageEvent, setProxyUsageSink } from "@app/ai-proxy/lib/usage/usage-events";

let dir: string;
let events: ProxyUsageEvent[];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proxy-usage-events-"));
    setClientLedgerDirForTests(dir);
    events = [];
    setProxyUsageSink((event) => events.push(event));
});

afterEach(() => {
    setProxyUsageSink(undefined);
    setClientLedgerDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
});

describe("proxy usage emission", () => {
    it("emits the cost the ledger booked, not a recomputed one", () => {
        recordClientUsage({
            client: "alice",
            ts: "2026-07-10T10:00:00.000Z",
            upstreamModel: "grok-4-fast",
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
            accountId: "acc_grok_work",
            provider: "grok-subscription",
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            app: "ai-proxy",
            at: "2026-07-10T10:00:00.000Z",
            accountId: "acc_grok_work",
            provider: "grok-subscription",
            modelId: "grok-4-fast",
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            costUsd: 0.7,
            meta: { kind: "proxy-request", client: "alice" },
        });
    });

    it("omits costUsd entirely for an unpriced model — never zero", () => {
        recordClientUsage({
            client: "alice",
            ts: "2026-07-10T10:00:00.000Z",
            upstreamModel: "mystery-model",
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            accountId: "acc_x",
            provider: "openai",
        });

        expect(events[0]).not.toHaveProperty("costUsd");
    });

    it("a throwing sink cannot break the booking", () => {
        setProxyUsageSink(() => {
            throw new Error("reader is down");
        });

        expect(() =>
            recordClientUsage({
                client: "alice",
                ts: "2026-07-10T10:00:00.000Z",
                upstreamModel: "grok-4-fast",
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                accountId: "acc_x",
                provider: "grok-subscription",
            })
        ).not.toThrow();
    });

    it("stays silent when the route carries no account identity", () => {
        recordClientUsage({
            client: "alice",
            ts: "2026-07-10T10:00:00.000Z",
            upstreamModel: "grok-4-fast",
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });

        expect(events).toEqual([]);
    });
});
