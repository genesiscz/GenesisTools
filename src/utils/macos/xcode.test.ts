import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    detectXcodeToolchain,
    genesisAppBuildHint,
    listCommandLineToolsSdks,
    resolveAppBuildSdk,
    sdkVersion,
    swiftUiStateIsPlainWrapper,
} from "./xcode";

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

describe("resolveAppBuildSdk", () => {
    const clt = { kind: "command-line-tools" as const, developerDir: "/Library/Developer/CommandLineTools" };
    const sdks = () => [`${clt.developerDir}/SDKs/MacOSX27.0.sdk`, `${clt.developerDir}/SDKs/MacOSX26.5.sdk`];

    it("leaves full Xcode on its own SDK", () => {
        expect(
            resolveAppBuildSdk({
                toolchain: { kind: "xcode", developerDir: "/Applications/Xcode.app/Contents/Developer" },
            })
        ).toEqual({ kind: "xcode" });
    });

    // Measured 2026-10-25: the 27.0 SDK's `@State` is a macro, the 26.5 SDK's is a property wrapper (#564).
    it("picks the newest Command Line Tools SDK whose @State needs no macro plugin", () => {
        const probed: string[] = [];
        const sdk = resolveAppBuildSdk({
            toolchain: clt,
            listSdks: sdks,
            probe: (sdkRoot) => {
                probed.push(sdkRoot);
                return sdkRoot.endsWith("MacOSX26.5.sdk");
            },
        });

        expect(sdk).toEqual({ kind: "command-line-tools", sdkRoot: `${clt.developerDir}/SDKs/MacOSX26.5.sdk` });
        expect(probed).toEqual(sdks());
    });

    it("is unsupported when no SDK passes, so the build refuses with the Xcode hint", () => {
        expect(resolveAppBuildSdk({ toolchain: clt, listSdks: sdks, probe: () => false })).toEqual({
            kind: "unsupported",
            toolchain: clt,
        });
    });

    it.each(["list", "probe"])("contains a %s exception so an optional update rebuild can be skipped", (stage) => {
        const fail = () => {
            throw new Error("SDK disappeared during a Command Line Tools update");
        };

        expect(
            resolveAppBuildSdk({
                toolchain: clt,
                listSdks: stage === "list" ? fail : sdks,
                probe: stage === "probe" ? fail : () => true,
            })
        ).toEqual({ kind: "unsupported", toolchain: clt });
        expect(resolveAppBuildSdk({ toolchain: clt, listSdks: sdks, probe: () => true })).toEqual({
            kind: "command-line-tools",
            sdkRoot: sdks()[0],
        });
    });

    it("contains a real SDK directory read error instead of aborting the update", () => {
        const developerDir = mkdtempSync(join(tmpdir(), "sdk-discovery-"));
        writeFileSync(join(developerDir, "SDKs"), "not a directory");
        const toolchain = { kind: "command-line-tools" as const, developerDir };

        expect(resolveAppBuildSdk({ toolchain })).toEqual({ kind: "unsupported", toolchain });
    });

    it("is unsupported without any toolchain", () => {
        expect(resolveAppBuildSdk({ toolchain: { kind: "none" } })).toEqual({
            kind: "unsupported",
            toolchain: { kind: "none" },
        });
    });
});

describe("listCommandLineToolsSdks", () => {
    it("sorts actual SDK directories numerically and excludes aliases and versioned symlinks", () => {
        const developerDir = mkdtempSync(join(tmpdir(), "sdk-list-"));
        const sdkDir = join(developerDir, "SDKs");
        const names = ["MacOSX26.9.sdk", "MacOSX27.0.sdk", "MacOSX26.10.sdk"];
        for (const name of [...names, "MacOSX.sdk", "MacOSX27.sdk"]) {
            mkdirSync(join(sdkDir, name), { recursive: true });
        }

        symlinkSync(join(sdkDir, names[0]), join(sdkDir, "MacOSX99.0.sdk"), "dir");

        expect(listCommandLineToolsSdks(developerDir)).toEqual(
            ["MacOSX27.0.sdk", "MacOSX26.10.sdk", "MacOSX26.9.sdk"].map((name) => join(sdkDir, name))
        );
    });
});

describe("sdkVersion", () => {
    it("reads major and minor, and skips the unversioned and major-only names (symlinks)", () => {
        expect(sdkVersion("MacOSX26.5.sdk")).toEqual([26, 5]);
        expect(sdkVersion("MacOSX27.0.sdk")).toEqual([27, 0]);
        expect(sdkVersion("MacOSX27.sdk")).toBeUndefined();
        expect(sdkVersion("MacOSX.sdk")).toBeUndefined();
    });
});

describe("swiftUiStateIsPlainWrapper", () => {
    const sdkRoot = "/fixture/SDKs/MacOSX26.5.sdk";
    const success = { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0, signal: null };

    async function withCache(run: (home: string) => void) {
        const home = mkdtempSync(join(tmpdir(), "sdk-probe-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => run(home));
    }

    it("bounds the compiler and retries a timeout instead of persisting an incompatible SDK", async () => {
        await withCache((home) => {
            const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
            const spawn = spyOn(childProcess, "spawnSync")
                .mockReturnValueOnce({ ...success, status: null, signal: "SIGKILL", error })
                .mockReturnValue(success);
            try {
                expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(false);
                expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(true);
                expect(spawn).toHaveBeenCalledTimes(2);
                expect(spawn.mock.calls[0]).toEqual([
                    "xcrun",
                    ["swiftc", "-typecheck", "-sdk", sdkRoot, "-target", expect.any(String), "-"],
                    expect.objectContaining({
                        timeout: 30_000,
                        killSignal: "SIGKILL",
                        input: expect.stringContaining("@State"),
                    }),
                ]);
                expect(readFileSync(join(home, ".genesis-tools", "app", "sdk-probe.json"), "utf8")).toContain(
                    '"ok": true'
                );
            } finally {
                spawn.mockRestore();
            }
        });
    });

    it.each(["null", "[]", '"text"', "{", '{"/fixture/SDKs/MacOSX26.5.sdk":{"stamp":"none","ok":"yes"}}'])(
        "treats invalid cache data %s as a miss",
        async (contents) => {
            await withCache((home) => {
                mkdirSync(join(home, ".genesis-tools", "app"), { recursive: true });
                writeFileSync(join(home, ".genesis-tools", "app", "sdk-probe.json"), contents);
                const spawn = spyOn(childProcess, "spawnSync").mockReturnValue(success);
                try {
                    expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(true);
                    expect(spawn).toHaveBeenCalledTimes(1);
                    expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(true);
                    expect(spawn).toHaveBeenCalledTimes(1);
                } finally {
                    spawn.mockRestore();
                }
            });
        }
    );

    it.each([true, false])("reuses a valid cached compatibility result of %s", async (ok) => {
        await withCache((home) => {
            mkdirSync(join(home, ".genesis-tools", "app"), { recursive: true });
            writeFileSync(
                join(home, ".genesis-tools", "app", "sdk-probe.json"),
                SafeJSON.stringify({ [sdkRoot]: { stamp: "none", ok } })
            );
            const spawn = spyOn(childProcess, "spawnSync").mockReturnValue(success);
            try {
                expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(ok);
                expect(spawn).not.toHaveBeenCalled();
            } finally {
                spawn.mockRestore();
            }
        });
    });

    it.each(["parent", "file"])("returns the probe result when the cache %s cannot be written", async (blocked) => {
        await withCache((home) => {
            if (blocked === "parent") {
                mkdirSync(join(home, ".genesis-tools"), { recursive: true });
                writeFileSync(join(home, ".genesis-tools", "app"), "blocked");
            } else {
                mkdirSync(join(home, ".genesis-tools", "app", "sdk-probe.json"), { recursive: true });
            }

            const spawn = spyOn(childProcess, "spawnSync").mockReturnValue(success);
            try {
                expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(true);
                expect(spawn).toHaveBeenCalledTimes(1);
            } finally {
                spawn.mockRestore();
            }
        });
    });

    it("persists a completed incompatible SDK result", async () => {
        await withCache(() => {
            const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({ ...success, status: 1 });
            try {
                expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(false);
                expect(swiftUiStateIsPlainWrapper(sdkRoot)).toBe(false);
                expect(spawn).toHaveBeenCalledTimes(1);
            } finally {
                spawn.mockRestore();
            }
        });
    });
});
