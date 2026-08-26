import { describe, expect, test } from "bun:test";
import { launchArgs } from "./browse.ts";

describe("launchArgs (PR #326 review — the profile-isolation rule, pinned)", () => {
    test("a plain launch carries the debug port and NO --user-data-dir (the real profile)", () => {
        const args = launchArgs(9222, {});
        expect(args).toContain("--remote-debugging-port=9222");
        expect(args.some((a) => a.startsWith("--user-data-dir"))).toBe(false);
        expect(args.some((a) => a.startsWith("--load-extension"))).toBe(false);
    });

    test("the real profile NEVER gets the private-network downgrade flag", () => {
        expect(launchArgs(9222, {}).some((a) => a.startsWith("--disable-features"))).toBe(false);
    });

    test("--fresh isolates into a /tmp profile so the user's own profile stays untouched", () => {
        const args = launchArgs(9223, { fresh: true });
        expect(args).toContain("--user-data-dir=/tmp/cdp-profile-9223");
        expect(args).toContain("--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks");
    });

    test("--extension implies its own profile and restricts loaded extensions to the one given", () => {
        const args = launchArgs(9333, { extension: "/dist/ext" });
        expect(args).toContain("--user-data-dir=/tmp/cdp-profile-9333");
        expect(args).toContain("--load-extension=/dist/ext");
        expect(args).toContain("--disable-extensions-except=/dist/ext");
    });
});
