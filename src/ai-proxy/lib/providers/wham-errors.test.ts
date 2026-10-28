import { describe, expect, it } from "bun:test";
import {
    anthropicClientStatus,
    classifyUpstreamFailure,
    failureText,
    readStreamHead,
} from "@app/ai-proxy/lib/providers/upstream-failure";
import { mapWhamError, parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";

const NOW = Date.parse("2026-10-26T10:00:00.000Z");

/** Upstream bodies in the shapes codex-rs parses (`error.type`, `resets_at` in seconds) and WHAM's FastAPI 400. */
const BODIES = {
    usageLimit:
        '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1792922400}}',
    usageLimitInSeconds:
        '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":5400}}',
    notIncluded: '{"error":{"type":"usage_not_included","message":"Codex is not included in your plan"}}',
    modelNotOnPlan: '{"detail":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}',
    shortRate: '{"error":{"message":"Rate limit reached for requests","code":"rate_limit_exceeded"}}',
    overloaded: '{"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded."}}',
    unauthorized: '{"detail":"Unauthorized"}',
    badRequest: '{"error":{"message":"Unsupported parameter: max_output_tokens","type":"invalid_request_error"}}',
};

describe("classifyUpstreamFailure", () => {
    it("names each account failure, and leaves an ordinary error alone", () => {
        const kinds = [
            classifyUpstreamFailure({ status: 429, bodyText: BODIES.usageLimit, now: NOW }),
            classifyUpstreamFailure({ status: 429, bodyText: BODIES.usageLimitInSeconds, now: NOW }),
            classifyUpstreamFailure({ status: 429, bodyText: BODIES.notIncluded }),
            classifyUpstreamFailure({ status: 400, bodyText: BODIES.modelNotOnPlan }),
            classifyUpstreamFailure({ status: 429, bodyText: BODIES.shortRate, retryAfterSec: 20 }),
            classifyUpstreamFailure({ status: 500, bodyText: BODIES.overloaded }),
            classifyUpstreamFailure({ status: 401, bodyText: BODIES.unauthorized }),
        ].map((failure) => [failure?.kind, failure?.resetsAtMs, failure?.retryAfterSec]);

        expect(kinds).toEqual([
            ["usage-limit", 1_792_922_400_000, undefined],
            ["usage-limit", NOW + 5_400_000, undefined],
            ["plan", undefined, undefined],
            ["plan", undefined, undefined],
            ["rate-limit", undefined, 20],
            ["overloaded", undefined, undefined],
            ["auth", undefined, undefined],
        ]);
        expect(classifyUpstreamFailure({ status: 400, bodyText: BODIES.badRequest })).toBeUndefined();
        expect(classifyUpstreamFailure({ status: 502, bodyText: "<html>bad gateway</html>" })).toBeUndefined();
    });

    it("gives Claude Code a status that shows the text: 400 for an account that cannot serve, 529 for an overload", () => {
        const statuses = (["usage-limit", "plan", "auth", "rate-limit", "overloaded"] as const).map((kind) =>
            anthropicClientStatus({ kind, status: 429 })
        );

        expect(statuses).toEqual([400, 400, 400, 429, 529]);
    });
});

describe("failureText", () => {
    const usageLimit = classifyUpstreamFailure({ status: 429, bodyText: BODIES.usageLimitInSeconds, now: NOW });

    if (!usageLimit) {
        throw new Error("the usage-limit body did not classify");
    }

    it("names the agent, account, model, upstream code and reset, and this session's switch command", () => {
        const text = failureText(
            usageLimit,
            {
                agent: "codex",
                proxyAccount: "login:work",
                account: "work",
                model: "gpt-6.1-sol",
                sessionId: "s-1",
                failover: false,
            },
            NOW
        );

        expect(text).toStartWith(
            "Codex account work hit its usage limit (gpt-6.1-sol, upstream 429 usage_limit_reached)."
        );
        expect(text).toContain("It resets at ");
        expect(text).toContain("(in 1h 30m)");
        expect(text).toContain("tools ai-proxy session s-1 use --codex '<account>'");
        expect(text).not.toContain("accounts failover");
    });

    it("offers the failover setting to a client without a session, and a new login for a dead one", () => {
        const text = failureText(
            { kind: "auth", status: 401 },
            {
                agent: "codex",
                proxyAccount: "codex",
                account: "codex",
                login: "work",
                model: "gpt-6.1-sol",
                failover: false,
            },
            NOW
        );

        expect(text).toContain("was refused after a token refresh");
        expect(text).toContain("tools codex login work");
        expect(text).toContain("tools ai-proxy accounts failover codex on");
    });
});

describe("readStreamHead", () => {
    function stream(text: string): ReadableStream<Uint8Array> {
        return new Response(text).body ?? new ReadableStream();
    }

    it("turns an overload before the first output into a failure and replays any other stream whole", async () => {
        const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n';
        const overloaded = `${created}event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"busy"}}}\n\n`;
        const normal = `${created}event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n`;

        const failed = await readStreamHead(stream(overloaded));
        const open = await readStreamHead(stream(normal));

        expect("failure" in failed ? [failed.failure.kind, failed.failure.code] : []).toEqual([
            "overloaded",
            "server_is_overloaded",
        ]);
        expect("body" in open ? await new Response(open.body).text() : "").toBe(normal);
    });
});

describe("mapWhamError", () => {
    it("keeps the upstream message for 400s and tolerates non-JSON bodies", () => {
        const bad = mapWhamError({
            status: 400,
            bodyText: '{"error":{"message":"Unsupported parameter: max_output_tokens","type":"invalid_request_error"}}',
        });
        expect(bad.error.message).toBe("Unsupported parameter: max_output_tokens");
        expect(bad.error.type).toBe("invalid_request_error");

        const html = mapWhamError({ status: 502, bodyText: "<html>bad gateway</html>" });
        expect(html.error.type).toBe("upstream_error");
        expect(html.error.message).toBe("ChatGPT upstream returned 502");
    });
});

describe("parseRetryAfterSeconds", () => {
    it("parses numeric Retry-After", () => {
        expect(parseRetryAfterSeconds(new Headers({ "retry-after": "42" }))).toBe(42);
    });

    it("returns undefined when absent or garbage", () => {
        expect(parseRetryAfterSeconds(new Headers())).toBeUndefined();
        expect(parseRetryAfterSeconds(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    });
});
