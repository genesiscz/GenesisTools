import { describe, expect, it } from "bun:test";
import { appendQueryParamsToSearchParams, buildUrl, withQueryParams } from "./url";

describe("appendQueryParamsToSearchParams", () => {
    it("sets string values", () => {
        const sp = appendQueryParamsToSearchParams({ foo: "bar" });
        expect(sp.get("foo")).toBe("bar");
    });

    it("appends array values", () => {
        const sp = appendQueryParamsToSearchParams({ tags: ["a", "b", "c"] });
        expect(sp.getAll("tags")).toEqual(["a", "b", "c"]);
    });

    it("skips undefined values", () => {
        const sp = appendQueryParamsToSearchParams({ foo: "bar", skip: undefined });
        expect(sp.has("skip")).toBe(false);
        expect(sp.get("foo")).toBe("bar");
    });

    it("appends to existing search params", () => {
        const existing = new URLSearchParams("existing=yes");
        const sp = appendQueryParamsToSearchParams({ foo: "bar" }, existing);
        expect(sp.get("existing")).toBe("yes");
        expect(sp.get("foo")).toBe("bar");
    });
});

describe("buildUrl", () => {
    it("returns base only", () => {
        expect(buildUrl({ base: "https://api.example.com" })).toBe("https://api.example.com");
    });

    it("joins segments", () => {
        expect(buildUrl({ base: "https://api.example.com", segments: ["v1", "users"] })).toBe(
            "https://api.example.com/v1/users"
        );
    });

    it("adds query params", () => {
        const url = buildUrl({ base: "https://api.example.com", queryParams: { page: "1", limit: "10" } });
        expect(url).toContain("page=1");
        expect(url).toContain("limit=10");
    });

    it("preserves trailing slash", () => {
        expect(buildUrl({ base: "https://api.example.com", segments: ["users/"] })).toBe(
            "https://api.example.com/users/"
        );
    });

    it("strips trailing slash when keepTrailingSlash is false", () => {
        expect(buildUrl({ base: "https://api.example.com", segments: ["users/"], keepTrailingSlash: false })).toBe(
            "https://api.example.com/users"
        );
    });

    it("merges with existing base query", () => {
        const url = buildUrl({ base: "https://api.example.com?existing=yes", queryParams: { foo: "bar" } });
        expect(url).toContain("existing=yes");
        expect(url).toContain("foo=bar");
    });

    it("extracts pathname from URL segments", () => {
        const url = buildUrl({ base: "https://api.example.com", segments: ["https://other.com/path/to/resource"] });
        expect(url).toBe("https://api.example.com/path/to/resource");
    });
});

describe("withQueryParams", () => {
    it("adds query params to a URL", () => {
        const result = withQueryParams("https://example.com/path", { foo: "bar" });
        expect(result).toContain("foo=bar");
    });

    it("appends to existing query params", () => {
        const result = withQueryParams("https://example.com/path?existing=1", { foo: "bar" });
        expect(result).toContain("existing=1");
        expect(result).toContain("foo=bar");
    });
});
