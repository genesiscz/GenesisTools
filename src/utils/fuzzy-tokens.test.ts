import { describe, expect, test } from "bun:test";
import { findTokenMatches, scoreEntry, tokenizeSearch } from "./fuzzy-tokens";

describe("fuzzy-tokens", () => {
    test("tokenizes on common separators", () => {
        expect(tokenizeSearch("commit-1c0 file:foo.ts")).toEqual(["commit", "1c0", "file", "foo", "ts"]);
    });

    test("matches across separator variations", () => {
        const tokens = tokenizeSearch("commit-1c0");

        for (const h of ["commit:1c0", "commit-1c0", "commit 1c0", "the commit 1c0 was bad"]) {
            const m = findTokenMatches(h, tokens);
            expect(m.length).toBeGreaterThanOrEqual(2);
        }
    });

    test("multi-token query finds discrete spans", () => {
        const tokens = tokenizeSearch("commit:1 commit:2");
        const matches = findTokenMatches("see commit 1 and later commit 2", tokens);

        expect(matches.length).toBeGreaterThanOrEqual(4);
    });

    test("scoreEntry requires all tokens", () => {
        expect(scoreEntry("commit 1c0 only", tokenizeSearch("commit 1c0"))).toBe(1);
        expect(scoreEntry("commit only", tokenizeSearch("commit 1c0"))).toBeLessThan(1);
    });
});
