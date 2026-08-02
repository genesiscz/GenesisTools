import { describe, expect, test } from "bun:test";
import { isClaudeForegroundCommand, parseClaudePaneTitle } from "@app/dev-dashboard/lib/tmux/claude-pane-title";

describe("parseClaudePaneTitle", () => {
    test("strips working and idle markers", () => {
        expect(parseClaudePaneTitle("✳ testt")).toBe("testt");
        expect(parseClaudePaneTitle("⠐ templates-todo")).toBe("templates-todo");
        expect(parseClaudePaneTitle("* testt")).toBe("testt");
    });

    test("keeps multi-word titles and sanitizes colons", () => {
        expect(parseClaudePaneTitle("✳ Debug formatting: spacing")).toBe("Debug formatting- spacing");
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
