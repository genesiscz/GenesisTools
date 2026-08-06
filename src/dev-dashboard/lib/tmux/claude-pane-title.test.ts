import { describe, expect, test } from "bun:test";
import { isClaudeForegroundCommand, parseClaudePaneTitle } from "@app/dev-dashboard/lib/tmux/claude-pane-title";

describe("parseClaudePaneTitle", () => {
    test("strips working and idle markers", () => {
        expect(parseClaudePaneTitle("✳ testt")).toBe("testt");
        expect(parseClaudePaneTitle("⠐ templates-todo")).toBe("templates-todo");
        expect(parseClaudePaneTitle("* testt")).toBe("testt");
    });

    test("accepts every animated braille spinner frame, not just U+2810", () => {
        // Observed live: a running session's title read `⠂ ttyd-naming` (U+2802) and parsed as null,
        // so the sync silently succeeded or failed depending on poll timing.
        for (const marker of ["⠂", "⠈", "⠠", "⣾", "⠋", "⠿", "⠀"]) {
            expect(parseClaudePaneTitle(`${marker} ttyd-naming`)).toBe("ttyd-naming");
        }
    });

    test("keeps multi-word titles and sanitizes colons", () => {
        expect(parseClaudePaneTitle("✳ Debug formatting: spacing")).toBe("Debug formatting- spacing");
    });

    test("sanitizes dots — tmux target-syntax separators that 3.6a silently munges to _ on rename", () => {
        expect(parseClaudePaneTitle("✳ Fix v1.2 bug")).toBe("Fix v1-2 bug");
        // Unicode ellipsis is NOT a dot — Claude's truncated auto-topic titles keep it.
        expect(parseClaudePaneTitle("✳ Analyze slow HAR file load…")).toBe("Analyze slow HAR file load…");
    });

    test("rejects non-Claude titles and the stock default", () => {
        expect(parseClaudePaneTitle("zsh")).toBeNull();
        expect(parseClaudePaneTitle("/Users/me/proj")).toBeNull();
        expect(parseClaudePaneTitle("…/Projects/Foo")).toBeNull();
        expect(parseClaudePaneTitle("")).toBeNull();
        expect(parseClaudePaneTitle(undefined)).toBeNull();
        expect(parseClaudePaneTitle("✳ Claude Code")).toBeNull();
        expect(parseClaudePaneTitle("⠐ Claude Code")).toBeNull();
    });
});

describe("isClaudeForegroundCommand", () => {
    test("matches claude binaries only", () => {
        expect(isClaudeForegroundCommand("claude")).toBe(true);
        expect(isClaudeForegroundCommand("/opt/homebrew/bin/claude")).toBe(true);
        expect(isClaudeForegroundCommand("claude-code")).toBe(true);
        expect(isClaudeForegroundCommand("bash")).toBe(false);
        expect(isClaudeForegroundCommand("cursor")).toBe(false);
        expect(isClaudeForegroundCommand(undefined)).toBe(false);
    });
});
