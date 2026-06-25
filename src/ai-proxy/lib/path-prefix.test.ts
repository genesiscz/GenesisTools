import { describe, expect, it } from "bun:test";
import { normalizeBasePath, stripBasePath } from "@app/ai-proxy/lib/path-prefix";

describe("path-prefix", () => {
    it("normalizes base paths", () => {
        expect(normalizeBasePath("/ai/")).toBe("/ai");
        expect(normalizeBasePath("ai")).toBe("/ai");
        expect(normalizeBasePath("")).toBe("");
    });

    it("strips configured prefix from incoming paths", () => {
        expect(stripBasePath("/ai/v1/models", "/ai")).toBe("/v1/models");
        expect(stripBasePath("/ai/health", "/ai")).toBe("/health");
        expect(stripBasePath("/v1/models", "/ai")).toBe("/v1/models");
    });
});
