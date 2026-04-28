import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { cwdFromTitle, lastCommandFromCapture } from "@app/cmux/lib/shell-probe";

describe("cwdFromTitle", () => {
    it("returns undefined for empty/null titles", () => {
        expect(cwdFromTitle(null)).toBeUndefined();
        expect(cwdFromTitle(undefined)).toBeUndefined();
        expect(cwdFromTitle("")).toBeUndefined();
    });

    it("expands user@host:~/path titles", () => {
        const out = cwdFromTitle("Martin@MacBook-Pro:~/Tresors/Projects/Foo");
        expect(out).toBe(join(homedir(), "Tresors/Projects/Foo"));
    });

    it("keeps absolute user@host:/abs paths", () => {
        const out = cwdFromTitle("user@host:/usr/local/bin");
        expect(out).toBe("/usr/local/bin");
    });

    it("expands ellipsis prefix titles (cmux abbreviation)", () => {
        const out = cwdFromTitle("…/Projects/Bar");
        expect(out).toBe(join(homedir(), "Projects/Bar"));
    });

    it("expands tilde prefix titles", () => {
        const out = cwdFromTitle("~/Documents");
        expect(out).toBe(join(homedir(), "Documents"));
    });

    it("returns absolute paths verbatim", () => {
        expect(cwdFromTitle("/etc")).toBe("/etc");
        expect(cwdFromTitle("/var/log/system")).toBe("/var/log/system");
    });

    it("ignores titles that don't look like paths (claude-style busy markers)", () => {
        expect(cwdFromTitle("✳ Debug formatting and spacing issues")).toBeUndefined();
        expect(cwdFromTitle("tools claude usage")).toBeUndefined();
        expect(cwdFromTitle("Terminal")).toBeUndefined();
    });
});

describe("lastCommandFromCapture", () => {
    it("returns none for empty input", () => {
        expect(lastCommandFromCapture("")).toEqual({ value: undefined, source: "none" });
        expect(lastCommandFromCapture(null)).toEqual({ value: undefined, source: "none" });
    });

    it("captures the most recent oh-my-zsh prompt above an empty trailing prompt", () => {
        const text = [
            "Last login: Mon Apr 27 19:24:32 on ttys013",
            "You have mail.",
            "➜  GenesisTools git:(fix/several) ✗ cd /Users/Martin/Tresors/Projects/GenesisTools",
            "➜  GenesisTools git:(feat/cmux) ✗ bun test src/cmux/lib/__tests__/",
            "20 pass, 0 fail",
            "➜  GenesisTools git:(feat/cmux) ✗",
        ].join("\n");
        expect(lastCommandFromCapture(text)).toEqual({
            value: "bun test src/cmux/lib/__tests__/",
            source: "scrollback",
        });
    });

    it("intentionally ignores bare-❯ prompts because Claude/Forge input boxes use the same glyph", () => {
        const text = "~/path\n❯ git status\nOn branch feat/cmux\n~/path\n❯";
        expect(lastCommandFromCapture(text)).toEqual({ value: undefined, source: "none" });
    });

    it("captures bracketed bash prompts", () => {
        const text = "[user@host ~/projects]$ npm run build\nbuild ok\n[user@host ~/projects]$";
        expect(lastCommandFromCapture(text)).toEqual({ value: "npm run build", source: "scrollback" });
    });

    it("captures a command currently typed at the prompt (not yet executed)", () => {
        const text = "➜  app git:(main) ✗ ./deploy.sh --staging";
        expect(lastCommandFromCapture(text)).toEqual({
            value: "./deploy.sh --staging",
            source: "scrollback",
        });
    });

    it("returns none for TUI screens with no shell prompt (Claude Code, vim, etc.)", () => {
        const text = [
            "⏺ Now push the worktree commits to remote.",
            "                                       143752 tokens",
            "──────────────────────────────────── timely-create-from-memory ──",
            "  claude-opus-4-7 plans-from-issues feat/cmux",
            "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
        ].join("\n");
        expect(lastCommandFromCapture(text)).toEqual({ value: undefined, source: "none" });
    });

    it("ignores empty trailing prompts (with or without ✗ dirty mark) and walks upward", () => {
        const text = "➜  app git:(main) ✗ ls\nfile.ts\n➜  app git:(main) ✗\n\n";
        expect(lastCommandFromCapture(text)).toEqual({ value: "ls", source: "scrollback" });
    });

    it("captures a claude --resume command typed at a prior shell prompt before the TUI", () => {
        const text = [
            "Last login: Mon Apr 27 14:00:00 on ttys001",
            "➜  GenesisTools git:(feat/cmux) ✗ claude --resume acb054fd-a584-4b2f-84ba-ed495b54d3f4",
            "Welcome to Claude Code",
            "[long TUI rendering follows...]",
        ].join("\n");
        expect(lastCommandFromCapture(text)).toEqual({
            value: "claude --resume acb054fd-a584-4b2f-84ba-ed495b54d3f4",
            source: "scrollback",
        });
    });

    it("walks past Claude TUI input boxes (bare ❯ chat lines) and finds the launching shell command", () => {
        const text = [
            "➜  GenesisTools git:(feat/cmux) ✗ claude --resume abc-123",
            "Welcome to Claude Code",
            "[lots of TUI rendering...]",
            "──────────────────────────────────── timely-create-from-memory ──",
            "❯ help me debug this issue with the parser?",
            "───────────────────────────────────────────────────────────────────",
            "  claude-opus-4-7 some-branch feat/cmux",
            "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
        ].join("\n");
        expect(lastCommandFromCapture(text)).toEqual({
            value: "claude --resume abc-123",
            source: "scrollback",
        });
    });
});
