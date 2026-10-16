import { describe, expect, test } from "bun:test";
import { APICallError, RetryError } from "ai";
import { describeAnthropicFailure } from "./failure";

function refusal(input: { statusCode: number; body: string; headers?: Record<string, string> }): APICallError {
    return new APICallError({
        message: "refused",
        url: "https://api.example.test/v1/messages",
        requestBodyValues: {},
        statusCode: input.statusCode,
        responseBody: input.body,
        ...(input.headers ? { responseHeaders: input.headers } : {}),
        isRetryable: input.statusCode === 429,
    });
}

const WEEKLY_RESET = 1_792_364_400;
const FIVE_HOUR_RESET = 1_792_174_800;

/** The headers of a real 429, values rounded: the weekly window full, the 5-hour window empty. */
const WEEKLY_FULL: Record<string, string> = {
    "anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET),
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.0",
    "anthropic-ratelimit-unified-7d-reset": String(WEEKLY_RESET),
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-utilization": "1.0",
};

describe("describeAnthropicFailure", () => {
    test("a 403 that blocks OAuth for the organization has no action a login can take", () => {
        const failure = describeAnthropicFailure(
            refusal({
                statusCode: 403,
                body: '{"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}}}',
            })
        );

        expect(failure?.kind).toBe("org-oauth-blocked");
        expect(failure?.message).toContain("403");
        expect(failure?.action).toContain("organization owner");
    });

    test("a 400 about the updated Consumer Terms says where to accept them", () => {
        const failure = describeAnthropicFailure(
            refusal({
                statusCode: 400,
                body: "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai",
            })
        );

        expect(failure?.kind).toBe("terms-update");
        expect(failure?.action).toContain("claude.ai");
    });

    test("a 429 with the weekly window full is a weekly limit with its reset time, also inside a RetryError", () => {
        const api = refusal({ statusCode: 429, body: "{}", headers: WEEKLY_FULL });
        const wrapped = new RetryError({
            message: "Failed after 3 attempts",
            reason: "maxRetriesExceeded",
            errors: [api, api, api],
        });

        for (const err of [api, wrapped]) {
            const failure = describeAnthropicFailure(err);

            expect(failure?.kind).toBe("weekly-limit");
            expect(failure?.message).toMatch(/^weekly limit used up, resets \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
            expect(failure?.action).toBeUndefined();
        }
    });

    test("a 429 with only the 5-hour window full is a session limit", () => {
        const failure = describeAnthropicFailure(
            refusal({
                statusCode: 429,
                body: "{}",
                headers: {
                    ...WEEKLY_FULL,
                    "anthropic-ratelimit-unified-5h-utilization": "1.0",
                    "anthropic-ratelimit-unified-7d-utilization": "0.4",
                },
            })
        );

        expect(failure?.kind).toBe("session-limit");
        expect(failure?.message).toStartWith("5-hour limit used up, resets ");
    });

    test("anything else is not recognised, so the caller keeps the original error", () => {
        expect(describeAnthropicFailure(refusal({ statusCode: 429, body: "{}" }))).toBeUndefined();
        expect(describeAnthropicFailure(refusal({ statusCode: 500, body: "boom" }))).toBeUndefined();
        expect(describeAnthropicFailure(new Error("socket hang up"))).toBeUndefined();
    });
});
