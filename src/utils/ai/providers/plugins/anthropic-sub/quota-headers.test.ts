import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { __resetUsagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

// Every header reading is charged to a probe budget kept on disk: keep it in a scratch home.
beforeAll(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "quota-headers-")));
    __resetUsagePollStorage();
});

afterAll(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    __resetUsagePollStorage();
});

// The refresh grant is single-use: the spy records every resolve and THROWS on a force-refresh
// unless a test asks for one, so a path that would spend it unasked fails loudly.
interface ResolveCall {
    name: string;
    forceRefresh?: boolean;
}

const resolveCalls: ResolveCall[] = [];
let resolveBehavior: "ok" | "dead" = "ok";
let allowForceRefresh = false;

mock.module("@genesiscz/utils/claude/subscription-auth", () => ({
    resolveAccountToken: async (name: string, opts: { forceRefresh?: boolean } = {}) => {
        resolveCalls.push({ name, forceRefresh: opts.forceRefresh });

        if (resolveBehavior === "dead") {
            throw new Error("invalid_grant: refresh token revoked");
        }

        if (opts.forceRefresh) {
            if (!allowForceRefresh) {
                throw new Error("force-refresh failed in this test");
            }

            return { token: "access-2", refreshed: true };
        }

        return { token: "access-1", refreshed: false };
    },
}));

const realSubscription = await import("@genesiscz/utils/ai/providers/plugins/anthropic-sub/subscription");

mock.module("@genesiscz/utils/ai/providers/plugins/anthropic-sub/subscription", () => ({
    ...realSubscription,
    isAnchorDue: () => false,
    planAllowsClaudeCode: () => true,
}));

const { pollAccount, isSubscriptionExpiredError, PollSuppressedError } = await import(
    "@genesiscz/utils/ai/providers/plugins/anthropic-sub/api"
);
const { persistedProbeBudget, probesInWindow, ProbeBudgetExceeded } = await import(
    "@genesiscz/utils/ai/providers/plugins/anthropic-sub/probe-budget"
);
const {
    fableReadingDue,
    fetchUsageFromHeaders,
    endpointAsOf,
    isHeaderReading,
    isQuotaHeaderFailure,
    mergeHeaderReading,
    usageFromQuotaHeaders,
    QUOTA_PROBE_FALLBACK_MODEL,
    QUOTA_PROBE_MODEL,
    QUOTA_PROBE_URL,
} = await import("@genesiscz/utils/ai/providers/plugins/anthropic-sub/quota-headers");
const { normalizeLimits } = await import("@genesiscz/utils/ai/providers/plugins/anthropic-sub/limits");
const { anthropicUsage } = await import("@genesiscz/utils/ai/providers/plugins/anthropic-sub/usage");
const { CC_VERSION, SUBSCRIPTION_SYSTEM_PREFIX } = await import("@genesiscz/utils/claude/subscription-billing");

type Usage = NonNullable<ReturnType<typeof usageFromQuotaHeaders>>;

const NOW = Date.parse("2026-09-27T11:00:00Z");
const LONG_LIVED = `sk-ant-oat01-${"x".repeat(100)}`;

function quotaHeaders(five = "0.23", seven = "0.39", fable?: string): Headers {
    return new Headers({
        "anthropic-ratelimit-unified-5h-utilization": five,
        "anthropic-ratelimit-unified-5h-reset": "1790516400",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": seven,
        "anthropic-ratelimit-unified-7d-reset": "1791046800",
        "anthropic-ratelimit-unified-7d-status": "allowed_warning",
        "anthropic-ratelimit-unified-status": "allowed_warning",
        "anthropic-ratelimit-unified-representative-claim": "seven_day",
        ...(fable === undefined
            ? {}
            : {
                  "anthropic-ratelimit-unified-7d_oi-utilization": fable,
                  "anthropic-ratelimit-unified-7d_oi-reset": "1791046800",
                  "anthropic-ratelimit-unified-7d_oi-status": "allowed",
              }),
    });
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const requests: string[] = [];
/** The status of the FIRST usage-endpoint request; later ones answer 200. */
let firstUsageStatus = 200;
const originalFetch = globalThis.fetch;

function stubFetch(): void {
    let usageRequests = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push(url);

        if (url === QUOTA_PROBE_URL) {
            return new Response("{}", { status: 200, headers: quotaHeaders() });
        }

        if (url === USAGE_URL) {
            usageRequests += 1;
            return usageRequests === 1 && firstUsageStatus !== 200
                ? new Response("rate limited", { status: firstUsageStatus })
                : Response.json({
                      five_hour: { utilization: 20, resets_at: "2026-09-27T13:40:00Z" },
                      seven_day: { utilization: 38, resets_at: "2026-10-03T17:00:00Z" },
                  });
        }

        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
}

function account(tokens: AIAccountEntry["tokens"]): AIAccountEntry {
    return { name: "work", provider: "anthropic-sub", tokens, subscriptionPlan: "claude_max" } as AIAccountEntry;
}

const withPair = () => account({ accessToken: "access-1", refreshToken: "refresh-1", longLivedToken: LONG_LIVED });

async function poll(entry: AIAccountEntry, extra: Record<string, unknown> = {}) {
    // `config` is only read by the profile paths, which the mocked subscription module never takes.
    return pollAccount({ account: entry, config: {} as unknown as AIConfig, gate: {}, now: NOW, ...extra });
}

/** An endpoint reading with the Fable limit, as `/api/oauth/usage` answers it. */
const ENDPOINT_READING: Usage = {
    five_hour: { utilization: 33, resets_at: "2026-09-27T13:40:00Z" },
    seven_day: { utilization: 42, resets_at: "2026-10-03T17:00:00Z" },
    seven_day_breakdown: { rows: [{ key: "claude_code", percent: 100 }] },
    limits: [
        {
            kind: "session",
            group: "session",
            percent: 33,
            severity: "normal",
            resets_at: "2026-09-27T13:40:00Z",
            scope: null,
            is_active: false,
        },
        {
            kind: "weekly_all",
            group: "weekly",
            percent: 42,
            severity: "normal",
            resets_at: "2026-10-03T17:00:00Z",
            scope: null,
            is_active: true,
        },
        {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 7,
            severity: "normal",
            resets_at: "2026-10-03T17:00:00Z",
            scope: { model: { id: "fable-id", display_name: "Fable" }, surface: null },
            is_active: false,
        },
    ],
};

function percents(usage: Usage | undefined): Record<string, number> {
    return Object.fromEntries(normalizeLimits(usage ?? ENDPOINT_READING).map((limit) => [limit.bucket, limit.percent]));
}

afterEach(() => {
    resolveCalls.length = 0;
    requests.length = 0;
    resolveBehavior = "ok";
    allowForceRefresh = false;
    firstUsageStatus = 200;
    globalThis.fetch = originalFetch;
});

describe("usageFromQuotaHeaders", () => {
    it("maps the header fractions to the endpoint's percents and the unix resets to ISO times", () => {
        const usage = usageFromQuotaHeaders(quotaHeaders("0.23", "0.39", "0.06"));

        expect(usage?.five_hour).toEqual({ utilization: 23, resets_at: "2026-09-27T13:40:00.000Z" });
        expect(usage?.seven_day).toEqual({ utilization: 39, resets_at: "2026-10-03T17:00:00.000Z" });
        // `7d_oi` is the Fable weekly window (Claude Code's "Fable limit").
        expect(usage?.seven_day_overage_included).toEqual({ utilization: 6, resets_at: "2026-10-03T17:00:00.000Z" });
        expect(usage?.quota).toMatchObject({ source: "headers", status: "allowed_warning", fableStatus: "allowed" });
        expect(isHeaderReading(usage ?? undefined)).toBe(true);
    });

    it("is null without either window, and a missing 5h window reads as no active period", () => {
        expect(usageFromQuotaHeaders(new Headers({ "content-type": "application/json" }))).toBeNull();

        const weeklyOnly = new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.5" });
        expect(usageFromQuotaHeaders(weeklyOnly)?.five_hour).toEqual({ utilization: 0, resets_at: null });
    });
});

describe("fetchUsageFromHeaders", () => {
    interface Sent {
        model: string;
        body: Record<string, unknown>;
        headers: Record<string, string>;
    }

    function recorder(answers: Array<() => Response>): { fetchImpl: typeof fetch; sent: Sent[] } {
        const sent: Sent[] = [];
        const fetchImpl = (async (_url: string, init: RequestInit) => {
            const body = SafeJSON.parse(String(init.body)) as Record<string, unknown>;
            sent.push({ model: String(body.model), body, headers: init.headers as Record<string, string> });
            const answer = answers[sent.length - 1] ?? answers[answers.length - 1];
            return answer();
        }) as unknown as typeof fetch;
        return { fetchImpl, sent };
    }

    /** A budget that never refuses, for the tests about the request itself. */
    const OPEN = { account: "work", budget: { spend: async () => undefined } };

    it("a spent budget refuses before anything is sent", async () => {
        // The spy on the spending call THROWS: a probe that got past the budget fails loudly.
        const fetchImpl = (async () => {
            throw new Error("a probe was sent past a spent budget");
        }) as unknown as typeof fetch;
        const spent = {
            spend: async (model: string) => {
                throw new ProbeBudgetExceeded("work", model, 400, 400);
            },
        };
        const error = await fetchUsageFromHeaders(LONG_LIVED, { account: "work", budget: spent, fetchImpl }).catch(
            (err: unknown) => err
        );

        expect(error).toBeInstanceOf(ProbeBudgetExceeded);
    });

    it("negative control: a budget with room charges the model it sends, once per request", async () => {
        const charged: string[] = [];
        const budget = { spend: async (model: string) => void charged.push(model) };
        const cheap = recorder([() => new Response("{}", { status: 200, headers: quotaHeaders() })]);
        await fetchUsageFromHeaders(LONG_LIVED, {
            account: "work",
            budget,
            withFable: false,
            fetchImpl: cheap.fetchImpl,
        });

        expect(cheap.sent.map((request) => request.model)).toEqual([QUOTA_PROBE_FALLBACK_MODEL]);
        expect(charged).toEqual([QUOTA_PROBE_FALLBACK_MODEL]);

        const refused = recorder([
            () => new Response('{"error":{"message":"model not supported"}}', { status: 400 }),
            () => new Response("{}", { status: 200, headers: quotaHeaders() }),
        ]);
        charged.length = 0;
        await fetchUsageFromHeaders(LONG_LIVED, { account: "work", budget, fetchImpl: refused.fetchImpl });

        expect(charged).toEqual([QUOTA_PROBE_MODEL, QUOTA_PROBE_FALLBACK_MODEL]);
    });

    it("asks a Fable model in Claude Code's request shape with max_tokens 0, and reads 200 and 429 alike", async () => {
        const ok = recorder([() => new Response("{}", { status: 200, headers: quotaHeaders("0.23", "0.39", "0.06") })]);
        const usage = await fetchUsageFromHeaders(LONG_LIVED, { ...OPEN, fetchImpl: ok.fetchImpl });

        expect(usage.seven_day_overage_included?.utilization).toBe(6);
        expect(ok.sent).toHaveLength(1);
        expect(ok.sent[0].body).toMatchObject({ model: QUOTA_PROBE_MODEL, max_tokens: 0 });
        // Without these the server refuses a Fable model (400 or a header-less 429).
        expect(SafeJSON.stringify(ok.sent[0].body.system)).toContain(SUBSCRIPTION_SYSTEM_PREFIX);
        expect(ok.sent[0].headers["anthropic-beta"]).toContain("claude-code-20250219");
        expect(ok.sent[0].headers["user-agent"]).toContain(CC_VERSION);

        const capped = recorder([() => new Response("{}", { status: 429, headers: quotaHeaders("1", "0.4") })]);
        expect(
            (await fetchUsageFromHeaders(LONG_LIVED, { ...OPEN, fetchImpl: capped.fetchImpl })).five_hour.utilization
        ).toBe(100);
    });

    it("asks the fallback model once when the Fable model is refused without headers", async () => {
        const { fetchImpl, sent } = recorder([
            () => new Response('{"error":{"message":"model not supported"}}', { status: 400 }),
            () => new Response("{}", { status: 200, headers: quotaHeaders() }),
        ]);
        const usage = await fetchUsageFromHeaders(LONG_LIVED, { ...OPEN, fetchImpl });

        expect(sent.map((request) => request.model)).toEqual([QUOTA_PROBE_MODEL, QUOTA_PROBE_FALLBACK_MODEL]);
        expect(usage.five_hour.utilization).toBe(23);
        expect(usage.seven_day_overage_included).toBeUndefined();
    });

    it("an org-level refusal throws with its body after ONE request, still classified as a dead subscription", async () => {
        const refusal = SafeJSON.stringify({
            error: { message: "OAuth authentication is currently not allowed for this organization." },
        });
        const { fetchImpl, sent } = recorder([() => new Response(refusal, { status: 403 })]);
        const error = await fetchUsageFromHeaders(LONG_LIVED, { ...OPEN, fetchImpl }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(Error);
        expect(sent).toHaveLength(1);
        expect(isSubscriptionExpiredError((error as Error).message)).toBe(true);
        expect(isQuotaHeaderFailure(String(error))).toBe(true);
    });
});

describe("mergeHeaderReading", () => {
    const ENDPOINT_AT = NOW - 10 * 60_000;

    it("lays the header windows over the last endpoint reading and keeps what only the endpoint returns", () => {
        const fresh = usageFromQuotaHeaders(quotaHeaders("0.23", "0.39", "0.06")) ?? undefined;
        const merged = mergeHeaderReading(fresh as Usage, ENDPOINT_READING, ENDPOINT_AT);

        expect(percents(merged)).toEqual({ five_hour: 23, seven_day: 39, seven_day_fable: 6 });
        expect(merged.seven_day_breakdown).toEqual(ENDPOINT_READING.seven_day_breakdown);
        expect(merged.limits?.find((limit) => limit.kind === "weekly_scoped")?.scope?.model?.id).toBe("fable-id");
        expect(endpointAsOf(merged)).toBe(new Date(ENDPOINT_AT).toISOString());
        expect(endpointAsOf(ENDPOINT_READING)).toBeUndefined();
    });

    it("keeps the endpoint's Fable value when the answer has no Fable window, and a chain keeps the first endpoint time", () => {
        const first = mergeHeaderReading(usageFromQuotaHeaders(quotaHeaders()) as Usage, ENDPOINT_READING, ENDPOINT_AT);
        const second = mergeHeaderReading(usageFromQuotaHeaders(quotaHeaders("0.3")) as Usage, first, NOW);

        expect(percents(second)).toEqual({ five_hour: 30, seven_day: 39, seven_day_fable: 7 });
        expect(second.quota).toMatchObject({ endpointAsOf: new Date(ENDPOINT_AT).toISOString() });
    });

    it("without an endpoint reading, the limits come from the headers alone", () => {
        const merged = mergeHeaderReading(
            usageFromQuotaHeaders(quotaHeaders("0.23", "0.39", "0.06")) as Usage,
            undefined,
            undefined
        );

        expect(percents(merged)).toEqual({ five_hour: 23, seven_day: 39, seven_day_fable: 6 });
        expect((merged.quota as { endpointAsOf?: string }).endpointAsOf).toBeUndefined();
    });
});

describe("anthropicUsage.pollsWhileGated", () => {
    const gated = (reason: string, credentials: AccountEntry["credentials"] = {}) => {
        const account = { credentials } as Pick<AccountEntry, "credentials"> as AccountEntry;
        return anthropicUsage.pollsWhileGated?.(account, { reason });
    };
    const withToken = (reason: string, longLivedToken?: string) => gated(reason, { longLivedToken });

    it("reads a gated account through its long-lived token until the header reading itself fails", () => {
        expect(withToken("Error: Token expired (invalid_grant). Run: tools claude login work", LONG_LIVED)).toBe(true);
        // A lapsed org answers 403 to every request: the backoff paces it, not every round.
        expect(
            withToken(
                "UpstreamStatusError: Quota headers 403: OAuth authentication is currently not allowed",
                LONG_LIVED
            )
        ).toBe(false);
        expect(withToken("Error: Token expired (invalid_grant)")).toBe(false);
    });

    it("does not gate-poll a token too short to be a real long-lived token, or one already past its expiry", () => {
        const reason = "Error: Token expired (invalid_grant). Run: tools claude login work";
        expect(withToken(reason, "sk-ant-oat01-too-short")).toBe(false);
        expect(gated(reason, { longLivedToken: LONG_LIVED, longLivedTokenExpiresAt: Date.now() - 1000 })).toBe(false);
        expect(gated(reason, { longLivedToken: LONG_LIVED, longLivedTokenExpiresAt: Date.now() + 3_600_000 })).toBe(
            true
        );
    });

    it("a vault SecureRef counts as present, since there is no local text to measure its length", () => {
        const reason = "Error: Token expired (invalid_grant). Run: tools claude login work";
        const credentials = { longLivedToken: { type: "secure" as const, path: "ai/acc/longLivedToken" } };
        expect(gated(reason, credentials)).toBe(true);
    });
});

describe("the Fable reading cadence", () => {
    const withFable = (readAtMsAgo: number) =>
        mergeHeaderReading(
            usageFromQuotaHeaders(quotaHeaders("0.1", "0.2", "0.3")) as Usage,
            undefined,
            undefined,
            NOW - readAtMsAgo
        );

    it("asks Fable without a Fable reading, not again within 30 minutes, and again after", () => {
        expect(fableReadingDue(undefined, NOW)).toBe(true);
        expect(fableReadingDue(ENDPOINT_READING, NOW)).toBe(true);
        expect(fableReadingDue(withFable(10 * 60_000), NOW)).toBe(false);
        expect(fableReadingDue(withFable(30 * 60_000), NOW)).toBe(true);
    });

    it("a cheap reading keeps the last Fable window with the time it was read", () => {
        const fable = withFable(10 * 60_000);
        const cheap = mergeHeaderReading(
            usageFromQuotaHeaders(quotaHeaders("0.4", "0.5")) as Usage,
            fable,
            NOW - 2 * 60_000,
            NOW
        );

        expect(percents(cheap)).toMatchObject({ five_hour: 40, seven_day: 50, seven_day_fable: 30 });
        expect(cheap.seven_day_overage_included?.utilization).toBe(30);
        expect(cheap.quota).toMatchObject({
            fableReadAt: new Date(NOW - 10 * 60_000).toISOString(),
            fableStatus: "allowed",
        });
    });
});

describe("the probe budget", () => {
    it("counts only the last 7 days", () => {
        const days = { "2026-09-20": 900, "2026-09-21": 5, "2026-09-27": 3 };

        expect(probesInWindow(days, NOW)).toBe(8);
    });

    it("refuses the probe past the cap, per account and model, and counts nothing when it refuses", async () => {
        const caps = { [QUOTA_PROBE_MODEL]: 2, [QUOTA_PROBE_FALLBACK_MODEL]: 1 };
        const work = persistedProbeBudget("work", caps);
        await work.spend(QUOTA_PROBE_MODEL);
        await work.spend(QUOTA_PROBE_MODEL);
        const third = await work.spend(QUOTA_PROBE_MODEL).catch((err: unknown) => err);

        expect(third).toBeInstanceOf(ProbeBudgetExceeded);
        expect((third as InstanceType<typeof ProbeBudgetExceeded>).spent).toBe(2);
        await work.spend(QUOTA_PROBE_FALLBACK_MODEL);
        await persistedProbeBudget("personal", caps).spend(QUOTA_PROBE_MODEL);
        expect(await work.spend(QUOTA_PROBE_MODEL).catch((err: unknown) => err)).toBeInstanceOf(ProbeBudgetExceeded);
    });
});

describe("pollAccount with a long-lived token", () => {
    it("the endpoint stays primary: a 429 rotates the token and reads the endpoint again, never the headers", async () => {
        stubFetch();
        firstUsageStatus = 429;
        allowForceRefresh = true;
        const result = await poll(withPair());

        expect(result.usage?.five_hour.utilization).toBe(20);
        expect(isHeaderReading(result.usage)).toBe(false);
        expect(resolveCalls.some((call) => call.forceRefresh)).toBe(true);
        expect(requests).toEqual([USAGE_URL, USAGE_URL]);
    });

    it("a 429 whose refresh fails falls back to the headers and keeps the endpoint's Fable limit", async () => {
        stubFetch();
        firstUsageStatus = 429;
        const result = await poll(withPair(), {
            previousUsage: ENDPOINT_READING,
            previousFetchedAt: NOW - 10 * 60_000,
        });

        expect(percents(result.usage)).toEqual({ five_hour: 23, seven_day: 39, seven_day_fable: 7 });
        expect(result.oauthFailure).toContain("force-refresh failed");
        expect(requests).toEqual([USAGE_URL, QUOTA_PROBE_URL]);
    });

    it("reads an account whose OAuth refresh died, also when its last reading shows a closed window", async () => {
        stubFetch();
        resolveBehavior = "dead";
        const read = await poll(withPair());

        expect(read.usage?.seven_day.utilization).toBe(39);
        // The reading is kept, and the dead refresh path is still reported so the gate backs it off.
        expect(read.oauthFailure).toContain("invalid_grant");

        requests.length = 0;
        // A reset that passed says nothing about now: the account may be in use again (2026-09-28).
        const closed = {
            five_hour: { utilization: 82, resets_at: "2026-09-27T10:30:00Z" },
            seven_day: { utilization: 40, resets_at: null },
        };
        const again = await poll(withPair(), { previousUsage: closed, previousFetchedAt: NOW - 3 * 60_000 });

        expect(again.usage?.five_hour.utilization).toBe(23);
        expect(requests).toEqual([QUOTA_PROBE_URL]);
    });

    it("a gated poll reads the headers without resolving any token, on a closed window too", async () => {
        stubFetch();
        const read = await poll(withPair(), { headersOnly: true });

        expect(read.usage?.five_hour.utilization).toBe(23);
        expect(resolveCalls).toEqual([]);

        const closed = {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 40, resets_at: null },
        };
        const again = await poll(withPair(), {
            headersOnly: true,
            previousUsage: closed,
            previousFetchedAt: NOW - 3 * 60_000,
        });

        expect(again.usage?.five_hour.utilization).toBe(23);
        expect(resolveCalls).toEqual([]);
    });

    it("a spent probe budget skips the account instead of failing it", async () => {
        stubFetch();
        const spent = {
            spend: async (model: string) => {
                throw new ProbeBudgetExceeded("work", model, 400, 400);
            },
        };
        const skipped = await poll(withPair(), { headersOnly: true, probeBudget: spent }).catch((err: unknown) => err);

        expect(skipped).toBeInstanceOf(PollSuppressedError);
        expect(String(skipped)).toContain("budget is spent");
        expect(requests).toEqual([]);
    });

    it("serves the last header reading again inside two minutes, stamped with its own time", async () => {
        stubFetch();
        const last = usageFromQuotaHeaders(quotaHeaders("0.5", "0.6"));
        const recent = await poll(withPair(), {
            headersOnly: true,
            previousUsage: last,
            previousFetchedAt: NOW - 60_000,
        });

        expect(recent.usage?.five_hour.utilization).toBe(50);
        expect(recent.readAt).toBe(NOW - 60_000);
        expect(requests).toEqual([]);

        const due = await poll(withPair(), {
            headersOnly: true,
            previousUsage: last,
            previousFetchedAt: NOW - 2 * 60_000,
        });

        expect(due.usage?.five_hour.utilization).toBe(23);
        expect(due.readAt).toBeUndefined();
        expect(requests).toEqual([QUOTA_PROBE_URL]);
    });

    it("a probe never takes a header reading (it is an inference request)", async () => {
        stubFetch();
        firstUsageStatus = 429;
        const error = await poll(withPair(), { probe: true }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(Error);
        expect(requests).toEqual([USAGE_URL]);
    });

    it("negative control: without a long-lived token a 429 still reaches the force-refresh, as before", async () => {
        stubFetch();
        firstUsageStatus = 429;
        allowForceRefresh = true;
        await poll(account({ accessToken: "access-1", refreshToken: "refresh-1" })).catch(() => undefined);

        expect(resolveCalls.some((call) => call.forceRefresh)).toBe(true);
        expect(requests).not.toContain(QUOTA_PROBE_URL);
    });
});
