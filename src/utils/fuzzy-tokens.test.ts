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
        const tokens = tokenizeSearch("alpha beta");
        const matches = findTokenMatches("alpha then beta", tokens);

        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("long pasted blob without spaces is one literal token", () => {
        const blob =
            "eutRXaItz0FjolTXkkK4um:APA91bHWGWIAINrQRw8XGvf_6-Pm4XPXThdi4i4Lin_m6L3fm5TXATIDt6AmBXBvM2VTpZJVChXfWfGYjZnYOH-LjwViz5Q3ckBPod8eWQ0bJ9XoREuYMF4";
        const tokens = tokenizeSearch(blob);

        expect(tokens).toHaveLength(1);
        expect(scoreEntry('INFO "App has been run 35x times"', tokens)).toBe(0);
        expect(scoreEntry(blob, tokens)).toBe(1);
    });

    test("scoreEntry requires all tokens", () => {
        expect(scoreEntry("commit 1c0 only", tokenizeSearch("commit 1c0"))).toBe(1);
        expect(scoreEntry("commit only", tokenizeSearch("commit 1c0"))).toBeLessThan(1);
    });

    test("tokenizes Windows-style path separators", () => {
        expect(tokenizeSearch("src\\foo\\bar.ts")).toEqual(["src", "foo", "bar", "ts"]);
        const tokens = tokenizeSearch("foo bar");
        const matches = findTokenMatches("C:\\Users\\me\\foo\\bar.ts", tokens);
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("duplicate query tokens do not reduce full-match score", () => {
        expect(scoreEntry("commit message", tokenizeSearch("commit commit"))).toBe(1);
    });
});
