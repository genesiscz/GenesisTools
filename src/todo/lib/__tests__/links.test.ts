import { describe, expect, it } from "bun:test";
import { parseLink, parseLinks } from "../links";

describe("parseLink", () => {
    it("parses PR shorthand", () => {
        const link = parseLink("pr:142");
        expect(link).toEqual({ type: "pr", ref: "142" });
    });

    it("parses issue shorthand", () => {
        const link = parseLink("issue:456");
        expect(link).toEqual({ type: "issue", ref: "456" });
    });

    it("parses ADO shorthand", () => {
        const link = parseLink("ado:78901");
        expect(link).toEqual({ type: "ado", ref: "78901" });
    });

    it("is case-insensitive for shorthand prefix", () => {
        const link = parseLink("PR:99");
        expect(link.type).toBe("pr");
        expect(link.ref).toBe("99");
    });

    it("parses GitHub PR URL with repo extraction", () => {
        const link = parseLink("https://github.com/anomalyco/opencode/pull/42");
        expect(link.type).toBe("pr");
        expect(link.ref).toBe("42");
        expect(link.repo).toBe("anomalyco/opencode");
    });

    it("parses GitHub issue URL with repo extraction", () => {
        const link = parseLink("https://github.com/anomalyco/opencode/issues/100");
        expect(link.type).toBe("issue");
        expect(link.ref).toBe("100");
        expect(link.repo).toBe("anomalyco/opencode");
    });

    it("handles HTTP (non-HTTPS) GitHub URLs", () => {
        const link = parseLink("http://github.com/owner/repo/pull/7");
        expect(link.type).toBe("pr");
        expect(link.ref).toBe("7");
        expect(link.repo).toBe("owner/repo");
    });

    it("parses arbitrary URL as url type", () => {
        const link = parseLink("https://jira.example.com/browse/PROJ-123");
        expect(link.type).toBe("url");
        expect(link.ref).toBe("https://jira.example.com/browse/PROJ-123");
        expect(link.repo).toBeUndefined();
    });

    it("throws on empty string", () => {
        expect(() => parseLink("")).toThrow();
    });
});

describe("parseLinks", () => {
    it("maps an array of inputs to TodoLink objects", () => {
        const links = parseLinks(["pr:42", "https://github.com/org/repo/issues/10", "https://example.com"]);

        expect(links).toHaveLength(3);
        expect(links[0].type).toBe("pr");
        expect(links[1].type).toBe("issue");
        expect(links[1].repo).toBe("org/repo");
        expect(links[2].type).toBe("url");
    });

    it("returns empty array for empty input", () => {
        expect(parseLinks([])).toEqual([]);
    });
});
