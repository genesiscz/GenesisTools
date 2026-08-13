import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    checkClientQuota,
    monthKeyFromTs,
    readClientLedger,
    recordClientUsage,
    setClientLedgerDirForTests,
} from "@app/ai-proxy/lib/usage/client-ledger";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "client-ledger-"));
    setClientLedgerDirForTests(dir);
});

afterEach(() => {
    setClientLedgerDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
});

describe("monthKeyFromTs", () => {
    it("uses the UTC month", () => {
        expect(monthKeyFromTs("2026-07-01T00:30:00.000Z")).toBe("2026-07");
        expect(monthKeyFromTs("2026-12-31T23:59:59.000Z")).toBe("2026-12");
    });
});

describe("recordClientUsage + readClientLedger", () => {
    it("accumulates tokens and cost per client per month", () => {
        recordClientUsage({
            client: "alice",
            ts: "2026-07-10T10:00:00.000Z",
            upstreamModel: "grok-4-fast",
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
        });
        recordClientUsage({
            client: "alice",
            ts: "2026-07-11T10:00:00.000Z",
            upstreamModel: "mystery-model",
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });

        const ledger = readClientLedger();
        const alice = ledger.months["2026-07"]?.alice;
        expect(alice?.requests).toBe(2);
        expect(alice?.total_tokens).toBe(2_000_015);
        expect(alice?.cost_usd).toBeCloseTo(0.7, 10);
    });
});

describe("checkClientQuota", () => {
    const client = (caps: { monthlyTokenCap?: number; monthlyCostCapUsd?: number }) => ({
        name: "alice",
        isOwner: false,
        config: { name: "alice", key: "k".repeat(24), ...caps },
    });

    it("owner and cap-less clients always pass", () => {
        expect(checkClientQuota({ name: "owner", isOwner: true }).ok).toBe(true);
        expect(checkClientQuota(client({})).ok).toBe(true);
    });

    it("enforces the token cap for the CURRENT UTC month", () => {
        const now = new Date().toISOString();
        recordClientUsage({
            client: "alice",
            ts: now,
            upstreamModel: "grok-4-fast",
            usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1_100 },
        });

        expect(checkClientQuota(client({ monthlyTokenCap: 2_000 })).ok).toBe(true);
        const denied = checkClientQuota(client({ monthlyTokenCap: 1_000 }));
        expect(denied.ok).toBe(false);

        if (!denied.ok) {
            expect(denied.reason).toContain("token");
        }
    });

    it("enforces the cost cap", () => {
        recordClientUsage({
            client: "alice",
            ts: new Date().toISOString(),
            upstreamModel: "grok-4",
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
        });

        const denied = checkClientQuota(client({ monthlyCostCapUsd: 10 }));
        expect(denied.ok).toBe(false);
    });
});

describe("upstream-priced booking", () => {
    /**
     * The upstream's own charge prices the route ACTUALLY taken at the rate
     * actually charged, which a local rate table cannot know. OpenRouter ids are
     * deliberately absent from `billing/pricing.ts`, so without this the request
     * would count as unpriced.
     */
    it("books the upstream cost instead of the local estimate", () => {
        const ts = new Date().toISOString();
        recordClientUsage({
            client: "alice",
            ts,
            upstreamModel: "anthropic/claude-sonnet-5",
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost_usd: 0.004 },
        });

        const entry = readClientLedger().months[monthKeyFromTs(ts)].alice;

        expect(entry.cost_usd).toBe(0.004);
        expect(entry.unpriced_requests).toBe(0);
        expect(entry.upstream_priced_requests).toBe(1);
    });

    /** Without the upstream number an OpenRouter id has no rate at all, by design. */
    it("counts an openrouter request with no upstream cost as unpriced", () => {
        const ts = new Date().toISOString();
        recordClientUsage({
            client: "bob",
            ts,
            upstreamModel: "anthropic/claude-sonnet-5",
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        });

        const entry = readClientLedger().months[monthKeyFromTs(ts)].bob;

        expect(entry.cost_usd).toBe(0);
        expect(entry.unpriced_requests).toBe(1);
        expect(entry.upstream_priced_requests).toBeUndefined();
    });

    /** A locally priced model keeps its estimate, and is not counted as exact. */
    it("leaves the local estimate in charge when no upstream cost arrives", () => {
        const ts = new Date().toISOString();
        recordClientUsage({
            client: "carol",
            ts,
            upstreamModel: "grok-4-fast",
            usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
        });

        const entry = readClientLedger().months[monthKeyFromTs(ts)].carol;

        expect(entry.cost_usd).toBeGreaterThan(0);
        expect(entry.upstream_priced_requests).toBeUndefined();
    });

    /** A negative or NaN cost added to a running total corrupts the whole month. */
    it("ignores an impossible upstream cost and falls back", () => {
        const ts = new Date().toISOString();
        recordClientUsage({
            client: "dave",
            ts,
            upstreamModel: "grok-4-fast",
            usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, cost_usd: -5 },
        });

        const entry = readClientLedger().months[monthKeyFromTs(ts)].dave;

        expect(entry.cost_usd).toBeGreaterThan(0);
        expect(entry.upstream_priced_requests).toBeUndefined();
    });

    it("an explicit zero upstream cost is booked as exactly zero", () => {
        const ts = new Date().toISOString();
        recordClientUsage({
            client: "erin",
            ts,
            upstreamModel: "some/free-route",
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost_usd: 0 },
        });

        const entry = readClientLedger().months[monthKeyFromTs(ts)].erin;

        expect(entry.cost_usd).toBe(0);
        expect(entry.unpriced_requests).toBe(0);
        expect(entry.upstream_priced_requests).toBe(1);
    });
});
