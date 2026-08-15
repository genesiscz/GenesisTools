import { describe, expect, test } from "bun:test";
import {
    isClaudeForegroundCommand,
    parseClaudePaneTitle,
    tmuxSessionNameFromTopic,
} from "@app/dev-dashboard/lib/tmux/claude-pane-title";

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

    // The topic is DISPLAY text. Routing it through the tmux-name sanitizer corrupted normal
    // punctuation and made a bound session's label disagree with the UI's own fallback parse.
    test("keeps punctuation in the displayed topic", () => {
        expect(parseClaudePaneTitle("✳ Debug formatting: spacing")).toBe("Debug formatting: spacing");
        expect(parseClaudePaneTitle("✳ Fix v1.2 bug")).toBe("Fix v1.2 bug");
        expect(parseClaudePaneTitle("✳ Analyze slow HAR file load…")).toBe("Analyze slow HAR file load…");
    });

    test("collapses runs of whitespace", () => {
        expect(parseClaudePaneTitle("✳   spaced   out  ")).toBe("spaced out");
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

describe("tmuxSessionNameFromTopic", () => {
    test("replaces tmux target-syntax separators, which 3.6a munges to _ on rename", () => {
        expect(tmuxSessionNameFromTopic("Fix v1.2 bug")).toBe("Fix v1-2 bug");
        expect(tmuxSessionNameFromTopic("Debug formatting: spacing")).toBe("Debug formatting- spacing");
        // Unicode ellipsis is NOT a dot — Claude's truncated auto-topic titles keep it.
        expect(tmuxSessionNameFromTopic("Analyze slow HAR file load…")).toBe("Analyze slow HAR file load…");
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
