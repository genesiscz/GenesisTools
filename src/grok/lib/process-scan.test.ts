import { describe, expect, test } from "bun:test";
import { classifyGrokArgs } from "./process-scan";

/**
 * Both grok doors run the same binary, so `tools grok who` has exactly one signal to work
 * with. Getting it wrong labels a headless worker as a pane someone is typing into.
 */
describe("classifyGrokArgs", () => {
    test("a headless turn carries the brief as a flag; a TUI never does", () => {
        expect(classifyGrokArgs("/Users/me/.bun/bin/grok -p 'fix the auth path' --session-id abc")).toBe("worker");
        expect(classifyGrokArgs("/Users/me/.bun/bin/grok --prompt-file /tmp/brief.md --session-id abc")).toBe("worker");
        expect(classifyGrokArgs("/Users/me/.bun/bin/grok")).toBe("tui");
        // `--resume` is on BOTH doors, so it can never be the signal.
        expect(classifyGrokArgs("/Users/me/.bun/bin/grok -r 01a05cc5-0ecf-7d40-945e-977e45b3f935")).toBe("tui");
    });

    test("ignores every other process", () => {
        expect(classifyGrokArgs("/usr/bin/grep grok /repo/src")).toBeNull();
        expect(classifyGrokArgs("/opt/homebrew/bin/codex")).toBeNull();
    });
});
