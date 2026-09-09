import { describe, expect, test } from "bun:test";
import { haystackMatch } from "./match";

describe("haystackMatch", () => {
    test("fuzzy requires every word", () => {
        expect(haystackMatch("PRs merged into release", "PRs merged", {})).toBe(true);
        expect(haystackMatch("PRs merged into release", "PRs missing", {})).toBe(false);
    });

    test("exact is case-insensitive substring, matching Claude history", () => {
        expect(haystackMatch("PRs merged into release", "merged into", { exact: true })).toBe(true);
        expect(haystackMatch("PRs merged into release", "PRs merged into release", { exact: true })).toBe(true);
    });
});
