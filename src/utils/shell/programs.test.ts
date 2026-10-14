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

    test("an agent or a command is not a shell, even when it names one in its arguments", () => {
        expect(isShellProgram("claude --resume x")).toBe(false);
        expect(isShellProgram("tmux new -s work zsh")).toBe(false);
        expect(programName("/opt/homebrew/bin/grok -r id")).toBe("grok");
    });
});
