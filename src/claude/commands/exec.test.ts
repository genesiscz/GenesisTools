import { describe, expect, test } from "bun:test";
import { launchGateForVerdict, parseExecArgs } from "./exec";

describe("parseExecArgs", () => {
    test("no account flag leaves the whole argv as the command", () => {
        expect(parseExecArgs(["git", "status"])).toEqual({
            name: undefined,
            skipVerify: false,
            command: ["git", "status"],
        });
    });

    test("-a takes the next word", () => {
        expect(parseExecArgs(["-a", "work", "git", "status"])).toEqual({ name: "work", skipVerify: false, command: ["git", "status"] });
    });

    test("--account takes the next word", () => {
        expect(parseExecArgs(["--account", "work", "git"])).toEqual({ name: "work", skipVerify: false, command: ["git"] });
    });

    test("--account=name form", () => {
        expect(parseExecArgs(["--account=work", "git"])).toEqual({ name: "work", skipVerify: false, command: ["git"] });
    });

    test("a child's own -a is NOT ours once the command started", () => {
        expect(parseExecArgs(["git", "-a", "commit"])).toEqual({ name: undefined, skipVerify: false, command: ["git", "-a", "commit"] });
    });

    test("a leading -- is stripped", () => {
        expect(parseExecArgs(["--", "--weird-binary"])).toEqual({ name: undefined, skipVerify: false, command: ["--weird-binary"] });
    });

    test("-a followed by -- strips the separator too", () => {
        expect(parseExecArgs(["-a", "work", "--", "env"])).toEqual({ name: "work", skipVerify: false, command: ["env"] });
    });

    test("empty argv yields an empty command so the caller can error", () => {
        expect(parseExecArgs([])).toEqual({ name: undefined, skipVerify: false, command: [] });
    });
});

describe("parseExecArgs --no-verify", () => {
    test("is ours when it leads, in either order with the account flag", () => {
        expect(parseExecArgs(["--no-verify", "git", "status"])).toEqual({
            name: undefined,
            skipVerify: true,
            command: ["git", "status"],
        });
        expect(parseExecArgs(["-a", "work", "--no-verify", "git"])).toEqual({
            name: "work",
            skipVerify: true,
            command: ["git"],
        });
        expect(parseExecArgs(["--no-verify", "--account=work", "git"])).toEqual({
            name: "work",
            skipVerify: true,
            command: ["git"],
        });
    });

    test("belongs to the CHILD once the command has started", () => {
        expect(parseExecArgs(["git", "commit", "--no-verify"])).toEqual({
            name: undefined,
            skipVerify: false,
            command: ["git", "commit", "--no-verify"],
        });
    });
});

// The guard exists because a right-length but EXPIRED token makes Claude Code fall back
// to the keychain silently, so the run bills the wrong account while claiming otherwise.
describe("launchGateForVerdict", () => {
    test("an invalid token blocks the launch and names the fix", () => {
        const gate = launchGateForVerdict("invalid", "work");

        expect(gate.launch).toBe(false);
        expect(gate.launch === false && gate.fix).toBe("tools claude login-long work");
    });

    // The other half: normal use must still run. A probe that cannot reach the API is
    // not evidence of a bad token, and a rate-limited token is still the right identity.
    test("ok, limited and unreachable all launch", () => {
        expect(launchGateForVerdict("ok", "work").launch).toBe(true);
        expect(launchGateForVerdict("limited", "work").launch).toBe(true);
        expect(launchGateForVerdict("unreachable", "work").launch).toBe(true);
    });
});
