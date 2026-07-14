import { describe, expect, test } from "bun:test";
import { isRateLimitError } from "./rate-limit";

describe("isRateLimitError", () => {
    test("429 is always rate limit", () => {
        expect(isRateLimitError({ status: 429, message: "too many requests" })).toBe(true);
    });

    test("403 with remaining=0 is rate limit", () => {
        expect(
            isRateLimitError({
                status: 403,
                message: "API rate limit exceeded",
                response: {
                    headers: { "x-ratelimit-remaining": "0" },
                    data: { message: "API rate limit exceeded" },
                },
            })
        ).toBe(true);
    });

    test("403 permission denial is NOT rate limit (no retry storm)", () => {
        expect(
            isRateLimitError({
                status: 403,
                message: "Resource not accessible by personal access token",
                response: {
                    headers: { "x-ratelimit-remaining": "4989" },
                    data: { message: "Resource not accessible by personal access token" },
                },
            })
        ).toBe(false);
    });

    test("other statuses are not rate limit", () => {
        expect(isRateLimitError({ status: 404, message: "Not Found" })).toBe(false);
        expect(isRateLimitError({ status: 422, message: "Validation Failed" })).toBe(false);
    });
});
