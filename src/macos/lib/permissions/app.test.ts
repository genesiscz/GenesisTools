import { describe, expect, it } from "bun:test";
import { assertFullXcodeToolchain, retiredBundlesToKeep, runningExecutableInodes } from "./app";

describe("runningExecutableInodes", () => {
    it("reads the inode lines of lsof -Fi and ignores the rest", () => {
        const stdout = ["p101", "ftxt", "i596381987", "p102", "ftxt", "i42", "ftxt", "i596381987"].join("\n");

        expect(runningExecutableInodes({ code: 0, stdout })).toEqual(new Set([596381987, 42]));
    });

    it("keeps every retired bundle when lsof gave no answer", () => {
        expect(runningExecutableInodes({ code: 1, stdout: "" })).toBeNull();
    });

    it("keeps every retired bundle when lsof failed after printing part of the list", () => {
        expect(runningExecutableInodes({ code: 1, stdout: ["p101", "ftxt", "i42"].join("\n") })).toBeNull();
    });
});

describe("assertFullXcodeToolchain", () => {
    it("does not throw when the full Xcode toolchain is active", () => {
        expect(() =>
            assertFullXcodeToolchain({ kind: "xcode", developerDir: "/Applications/Xcode.app/Contents/Developer" })
        ).not.toThrow();
    });

    it("refuses with the Xcode-install hint instead of letting swift build run and dump errors", () => {
        expect(() =>
            assertFullXcodeToolchain({
                kind: "command-line-tools",
                developerDir: "/Library/Developer/CommandLineTools",
            })
        ).toThrow("GenesisTools.app needs the full Xcode");
    });

    it("refuses the same way when xcode-select names no toolchain at all", () => {
        expect(() => assertFullXcodeToolchain({ kind: "none" })).toThrow("GenesisTools.app needs the full Xcode");
    });
});

describe("retiredBundlesToKeep", () => {
    const inodes: Record<string, number | null> = { "100": 1, "200": 2, "300": 3, "400": null, "500": 5 };
    const inodeOf = (entry: string) => inodes[entry] ?? null;

    it("keeps the newest and every bundle a running process executes, and nothing else", () => {
        const keep = retiredBundlesToKeep({ entries: ["100", "200", "300", "500"], inodeOf, running: new Set([2]) });

        expect([...keep].sort()).toEqual(["200", "500"]);
    });

    it("keeps a bundle whose binary it cannot stat", () => {
        const keep = retiredBundlesToKeep({ entries: ["100", "400", "500"], inodeOf, running: new Set() });

        expect([...keep].sort()).toEqual(["400", "500"]);
    });
});
