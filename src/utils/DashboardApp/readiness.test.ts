import { describe, expect, test } from "bun:test";
import { isHttpServingStatus } from "./readiness";

describe("isHttpServingStatus", () => {
    test("accepts 2xx–4xx", () => {
        expect(isHttpServingStatus(200)).toBe(true);
        expect(isHttpServingStatus(404)).toBe(true);
    });

    test("rejects gateway-unavailable statuses", () => {
        expect(isHttpServingStatus(502)).toBe(false);
        expect(isHttpServingStatus(503)).toBe(false);
        expect(isHttpServingStatus(504)).toBe(false);
    });
});
