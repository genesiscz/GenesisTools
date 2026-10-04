import { describe, expect, it } from "bun:test";
import { detectXcodeToolchain, genesisAppBuildHint } from "./xcode";

function fakeSpawn(exitCode: number, stdout: string) {
    return () => ({ exitCode, stdout });
}

describe("detectXcodeToolchain", () => {
    it("classifies a Command Line Tools path", () => {
        const toolchain = detectXcodeToolchain({
            force: true,
            spawnSync: fakeSpawn(0, "/Library/Developer/CommandLineTools\n"),
        });

        expect(toolchain).toEqual({
            kind: "command-line-tools",
            developerDir: "/Library/Developer/CommandLineTools",
        });
    });

    it("classifies a full Xcode path", () => {
        const toolchain = detectXcodeToolchain({
            force: true,
            spawnSync: fakeSpawn(0, "/Applications/Xcode.app/Contents/Developer\n"),
        });

        expect(toolchain).toEqual({ kind: "xcode", developerDir: "/Applications/Xcode.app/Contents/Developer" });
    });

    it("reports none when xcode-select exits non-zero", () => {
        const toolchain = detectXcodeToolchain({ force: true, spawnSync: fakeSpawn(2, "") });

        expect(toolchain).toEqual({ kind: "none" });
    });

    it("reports none instead of throwing when the spawn itself throws", () => {
        const toolchain = detectXcodeToolchain({
            force: true,
            spawnSync: () => {
                throw new Error("boom");
            },
        });

        expect(toolchain).toEqual({ kind: "none" });
    });

    it("caches the result across calls until forced", () => {
        detectXcodeToolchain({
            force: true,
            spawnSync: fakeSpawn(0, "/Applications/Xcode.app/Contents/Developer\n"),
        });
        let calls = 0;
        const toolchain = detectXcodeToolchain({
            spawnSync: () => {
                calls++;
                return { exitCode: 0, stdout: "/Library/Developer/CommandLineTools\n" };
            },
        });

        expect(toolchain).toEqual({ kind: "xcode", developerDir: "/Applications/Xcode.app/Contents/Developer" });
        expect(calls).toBe(0);
    });
});

describe("genesisAppBuildHint", () => {
    it("tells a full Xcode toolchain to just run the build", () => {
        const hint = genesisAppBuildHint({ kind: "xcode", developerDir: "/Applications/Xcode.app/Contents/Developer" });

        expect(hint).toBe("Run `tools macos permissions build`.");
    });

    it("tells a Command Line Tools toolchain to install Xcode first", () => {
        const hint = genesisAppBuildHint({
            kind: "command-line-tools",
            developerDir: "/Library/Developer/CommandLineTools",
        });

        expect(hint).toBe(
            "GenesisTools.app needs the full Xcode (SwiftUI macros are not in the Command Line Tools): install Xcode, select it with `sudo xcode-select -s <path to your Xcode.app>` (for example /Applications/Xcode.app), then `tools macos permissions build`."
        );
    });

    it("gives the same install-Xcode message when there is no toolchain at all", () => {
        expect(genesisAppBuildHint({ kind: "none" })).toBe(
            "GenesisTools.app needs the full Xcode (SwiftUI macros are not in the Command Line Tools): install Xcode, select it with `sudo xcode-select -s <path to your Xcode.app>` (for example /Applications/Xcode.app), then `tools macos permissions build`."
        );
    });

    // Regression test: PR #457 review — `sudo xcode-select -s /Applications/Xcode.app` fails for
    // Xcode-beta.app or an Xcode installed anywhere else, so the hint must not prescribe that path.
    it("does not prescribe one fixed Xcode path", () => {
        expect(genesisAppBuildHint({ kind: "none" })).not.toContain("xcode-select -s /Applications/Xcode.app");
    });
});
