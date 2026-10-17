import { describe, expect, test } from "bun:test";
import { classifyCodexArgs, codexResumeIdFromArgs } from "./process-scan";

/**
 * `tools codex who` is only as honest as this classifier. Too wide and the machinery is
 * listed as billable sessions; too narrow and it reports "no live processes" while a pane is
 * running, which reads exactly like the feature not working.
 */
describe("classifyCodexArgs", () => {
    test("separates the pane a person types in from the machinery behind it", () => {
        expect(classifyCodexArgs("/opt/homebrew/bin/codex --remote /tmp/sock.1")).toBe("tui");
        expect(classifyCodexArgs("/opt/homebrew/bin/codex app-server")).toBe("app-server");
        expect(classifyCodexArgs("/Users/me/.bun/bin/bun /repo/src/codex/daemon.ts --name reviewer")).toBe("daemon");
    });

    test("ignores processes that are not codex at all", () => {
        expect(classifyCodexArgs("/Users/me/.bun/bin/bun /repo/src/grok/index.ts who")).toBeNull();
        expect(classifyCodexArgs("/usr/bin/ssh codex.example.com")).toBeNull();
        expect(classifyCodexArgs("")).toBeNull();
    });
});

describe("codexResumeIdFromArgs", () => {
    const id = "11111111-1111-4111-8111-111111111111";

    test("reads native IDs before or after picker options", () => {
        expect(codexResumeIdFromArgs(`codex resume ${id}`)).toBe(id);
        expect(codexResumeIdFromArgs(`codex resume --model o3 ${id}`)).toBe(id);
        expect(codexResumeIdFromArgs(`codex --model o3 resume ${id} --last`)).toBe(id);
    });

    test("picker option values and prompt words are not session IDs", () => {
        expect(codexResumeIdFromArgs("codex resume --model o3")).toBeNull();
        expect(codexResumeIdFromArgs("codex resume --model gpt-5.6")).toBeNull();
        expect(codexResumeIdFromArgs("codex resume --last")).toBeNull();
        expect(codexResumeIdFromArgs('codex "fix the resume page"')).toBeNull();
    });
});
