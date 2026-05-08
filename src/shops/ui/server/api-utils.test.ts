import { describe, expect, it } from "bun:test";
import { enumParam, intParam, parseQuery, safeJsonBody } from "./api-utils";

describe("intParam", () => {
    it("returns fallback when missing", () => {
        const result = intParam(new URLSearchParams(""), "limit", 50);
        expect(result).toBe(50);
    });

    it("clamps to max", () => {
        const result = intParam(new URLSearchParams("limit=999"), "limit", 50, { max: 100 });
        expect(result).toBe(100);
    });

    it("clamps to min", () => {
        const result = intParam(new URLSearchParams("limit=-5"), "limit", 50, { min: 0 });
        expect(result).toBe(0);
    });

    it("throws on non-integer", () => {
        expect(() => intParam(new URLSearchParams("limit=abc"), "limit", 50)).toThrow("must be an integer");
    });
});

describe("enumParam", () => {
    it("returns fallback when missing", () => {
        const result = enumParam(new URLSearchParams(""), "status", ["pending", "accepted"] as const, "pending");
        expect(result).toBe("pending");
    });

    it("throws when not in allow-list", () => {
        expect(() =>
            enumParam(new URLSearchParams("status=bogus"), "status", ["pending", "accepted"] as const, "pending")
        ).toThrow("must be one of");
    });
});

describe("parseQuery", () => {
    it("returns parsed object", () => {
        const result = parseQuery(new Request("http://test/?limit=20"), (p) => ({
            limit: intParam(p, "limit", 50),
        }));
        expect(result).toEqual({ limit: 20 });
    });

    it("returns 400 Response on Error", () => {
        const result = parseQuery(new Request("http://test/?limit=abc"), (p) => {
            try {
                return { limit: intParam(p, "limit", 50) };
            } catch (err) {
                return err as Error;
            }
        });
        expect(result).toBeInstanceOf(Response);
    });
});

describe("safeJsonBody", () => {
    it("parses JSONC with comments", async () => {
        const req = new Request("http://test/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: '{ /* comment */ "url": "https://example.com" }',
        });
        const result = await safeJsonBody(req);
        expect(result).toEqual({ url: "https://example.com" });
    });

    it("returns 400 on broken JSON", async () => {
        const req = new Request("http://test/", { method: "POST", body: "{not json" });
        const result = await safeJsonBody(req);
        expect(result).toBeInstanceOf(Response);
    });
});
