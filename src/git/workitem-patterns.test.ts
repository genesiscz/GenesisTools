import { describe, expect, it } from "bun:test";
import {
    extractFromBranch,
    extractFromMessage,
    loadWorkitemPatterns,
    suggestPatterns,
} from "@app/git/workitem-patterns";

describe("default workitem patterns", () => {
    it("reads a PREFIX-123 key from a commit message", () => {
        const refs = extractFromMessage("fix(login): ABC-123 stop the redirect loop");

        expect(refs.map((ref) => ref.id)).toEqual([123]);
    });

    it("reads a lowercase key and a #id from a commit message", () => {
        const refs = extractFromMessage("abc-42 and #123456 both land here");

        expect(refs.map((ref) => ref.id)).toEqual([42, 123456]);
    });

    it("reads the key from a branch name with or without a trailing description", () => {
        expect(extractFromBranch("feature/ABC-123-fix-login").map((ref) => ref.id)).toEqual([123]);
        expect(extractFromBranch("feature/ABC-123").map((ref) => ref.id)).toEqual([123]);
    });

    it("finds nothing in text that carries no key", () => {
        expect(extractFromMessage("tidy up the readme")).toEqual([]);
        expect(extractFromBranch("main")).toEqual([]);
    });

    it("does not ship an organisation specific default", () => {
        const regexes = loadWorkitemPatterns().map((pattern) => pattern.regex);

        expect(regexes.every((regex) => !/col/i.test(regex))).toBe(true);
    });
});

describe("suggestPatterns", () => {
    it("proposes the generic PREFIX-NUMBER pattern for matching history", () => {
        const suggestions = suggestPatterns(["ABC-1 first", "ABC-2 second"], ["feature/ABC-3-third"]);

        expect(suggestions.map((suggestion) => suggestion.pattern.regex)).toContain("(\\w+)-(\\d+)");
        expect(suggestions.map((suggestion) => suggestion.pattern.regex)).toContain("(\\w+)-(\\d+)-");
    });
});
