/**
 * `validateToPid` — the PR's headline safety fix, as a pure function.
 *
 * WHY IT MATTERS. Measured 2026-09-09: `hotkey --keys cmd,b --to-pid 99999`
 * printed `sent cmd,b` and exited 0 with no such process, having silently
 * fallen back to the GLOBAL event tap, so the combo landed in whatever window
 * the human had focused. The guard turns that into a refusal.
 *
 * BOTH HALVES ARE TESTED, per the house rule. A guard that rejects everything
 * would pass a rejection-only suite while breaking every real confined send, so
 * the live-pid cases are as load-bearing as the rejection cases.
 */
import { describe, expect, test } from "bun:test";
import { validateToPid } from "./interact";

describe("validateToPid", () => {
    test("undefined is fine — the flag is optional", () => {
        expect(validateToPid(undefined)).toBeNull();
    });

    describe("rejects, naming the pid and saying nothing was posted", () => {
        test("a pid with no running process", () => {
            const error = validateToPid("99999");

            expect(error).toContain("99999");
            expect(error).toContain("No event was posted");
        });

        test.each([
            ["not a number", "abc"],
            ["zero", "0"],
            ["negative", "-1"],
            ["fractional", "12.5"],
            ["empty", ""],
        ])("%s", (_label, value) => {
            expect(validateToPid(value)).toContain("No event was posted");
        });
    });

    describe("negative control — a real process still passes", () => {
        test("this process", () => {
            expect(validateToPid(String(process.pid))).toBeNull();
        });

        test("pid 1 (launchd): it exists and is not ours, which EPERM must not reject", () => {
            // A non-root caller cannot signal launchd, so a bare liveness probe reports EPERM
            // there. Reading that as "no such process" would refuse every send to another
            // user's app; classifyPid says "unverified", not "dead", which is the distinction.
            expect(validateToPid("1")).toBeNull();
        });
    });
});
