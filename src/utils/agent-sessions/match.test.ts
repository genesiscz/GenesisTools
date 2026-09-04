import { describe, expect, test } from "bun:test";
import { haystackMatch, sessionMatchesCwd } from "./match";
import type { AgentSession } from "./types";

describe("sessionMatchesCwd", () => {
    const session: AgentSession = {
        kind: "grok",
        sessionId: "s1",
        cwd: "/Users/me/Projects/shop",
        title: "t",
        mtime: new Date(0),
        filePath: "/tmp/s1.jsonl",
        project: "shop",
    };

    test("matches a project by leaf name", () => {
        expect(sessionMatchesCwd(session, { project: "shop" })).toBe(true);
        expect(sessionMatchesCwd(session, { project: "side" })).toBe(false);
    });

    test("derives the leaf name when the adapter did not record one", () => {
        expect(sessionMatchesCwd({ ...session, project: undefined }, { project: "shop" })).toBe(true);
    });

    test("cwd stays an exact absolute comparison", () => {
        expect(sessionMatchesCwd(session, { cwd: "/Users/me/Projects/shop" })).toBe(true);
        expect(sessionMatchesCwd(session, { cwd: "shop" })).toBe(false);
    });

    test("--all ignores both", () => {
        expect(sessionMatchesCwd(session, { all: true, project: "side", cwd: "/nope" })).toBe(true);
    });
});

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
