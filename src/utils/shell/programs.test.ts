import { describe, expect, test } from "bun:test";
import { isShellProgram, programName } from "./programs";

describe("isShellProgram", () => {
    test("a shell by name, path or login form is a shell; login only when asked", () => {
        expect(isShellProgram("-zsh")).toBe(true);
        expect(isShellProgram("/bin/bash -l")).toBe(true);
        expect(isShellProgram("dash")).toBe(true);
        expect(isShellProgram("/usr/bin/login -pf me")).toBe(false);
        expect(isShellProgram("/usr/bin/login -pf me", { orLogin: true })).toBe(true);
    });

    test("Windows and mixed path separators preserve shell and login detection", () => {
        expect(programName(String.raw`C:\bin\bash -l`)).toBe("bash");
        expect(isShellProgram(String.raw`C:\bin\bash -l`)).toBe(true);
        expect(isShellProgram(String.raw`C:\bin/zsh -l`)).toBe(true);
        expect(isShellProgram(String.raw`C:\bin\login -pf alice`)).toBe(false);
        expect(isShellProgram(String.raw`C:\bin\login -pf alice`, { orLogin: true })).toBe(true);
        expect(isShellProgram(String.raw`C:\bin\codex resume fixture`)).toBe(false);
    });

    test("an agent or a command is not a shell, even when it names one in its arguments", () => {
        expect(isShellProgram("claude --resume x")).toBe(false);
        expect(isShellProgram("tmux new -s work zsh")).toBe(false);
        expect(programName("/opt/homebrew/bin/grok -r id")).toBe("grok");
    });
});
