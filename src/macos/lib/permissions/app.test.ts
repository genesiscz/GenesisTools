import { describe, expect, it } from "bun:test";
import { retiredBundleCutoff } from "./app";

const BINARY = "/Users/example/Applications/GenesisTools.app/Contents/MacOS/GenesisTools";

describe("retiredBundleCutoff", () => {
    it("is one second before the oldest running GenesisTools process started", () => {
        const stdout = [
            "Thu Sep 25 05:08:00 2026     /sbin/launchd",
            `Thu Sep 25 05:10:00 2026     ${BINARY} --rpc`,
            `Thu Sep  4 05:08:00 2026     ${BINARY} claude`,
        ].join("\n");

        expect(retiredBundleCutoff({ code: 0, stdout })).toBe(Date.parse("Thu Sep  4 05:08:00 2026") - 1000);
    });

    it("lets every retired bundle go when no GenesisTools process runs", () => {
        expect(retiredBundleCutoff({ code: 0, stdout: "Thu Sep 25 05:08:00 2026     /sbin/launchd\n" })).toBe(
            Number.POSITIVE_INFINITY
        );
    });

    it("keeps every retired bundle when ps fails", () => {
        expect(retiredBundleCutoff({ code: 1, stdout: "" })).toBeNull();
    });

    it("keeps every retired bundle when one start time does not parse", () => {
        const stdout = [
            `Thu Sep 25 05:10:00 2026     ${BINARY} --rpc`,
            `čt 25 září 05:08:00 2026     ${BINARY} claude`,
        ].join("\n");

        expect(retiredBundleCutoff({ code: 0, stdout })).toBeNull();
    });
});
