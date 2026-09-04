import { describe, expect, test } from "bun:test";
import { tmuxKeychainPrintConflict } from "./start";

describe("tmuxKeychainPrintConflict", () => {
    test("rejects --tmux --keychain --print", () => {
        expect(tmuxKeychainPrintConflict(true, true, ["--print"])).toBe(true);
        expect(tmuxKeychainPrintConflict(true, true, ["-p"])).toBe(true);
        expect(tmuxKeychainPrintConflict(true, true, [])).toBe(false);
        expect(tmuxKeychainPrintConflict(true, false, ["--print"])).toBe(false);
    });
});
