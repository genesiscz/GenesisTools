import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFullXcodeToolchain, retiredBundlesToKeep, runningExecutableInodes } from "./app";
import {
    type BuildOfferDeps,
    createRealBuildOfferDeps,
    DECLINE_COOLDOWN_MS,
    isGatedInvocation,
    maybeOfferGenesisAppBuild,
    readOfferStateFrom,
    shouldAsk,
    writeOfferStateTo,
} from "./build-offer";

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

describe("isGatedInvocation", () => {
    it("gates a control command that drives the UI", () => {
        expect(isGatedInvocation("control", ["see", "--app", "Finder"])).toBe(true);
    });

    // Regression test: Fable judge J1 — a diagnostic or a help page must never prompt or write the cooldown file.
    it.each([["doctor"], ["audit"], ["--help"], ["-h"], ["help"]])("does not gate control %s", (arg) => {
        expect(isGatedInvocation("control", [arg])).toBe(false);
    });

    it("does not gate --help after a control subcommand", () => {
        expect(isGatedInvocation("control", ["see", "--help"])).toBe(false);
    });

    // Regression test: PR #456 review round 2 — reading a README is documentation, like --help,
    // and must never prompt for a build or write the cooldown file
    it("does not gate --readme, after a subcommand or alone", () => {
        expect(isGatedInvocation("control", ["see", "--readme"])).toBe(false);
        expect(isGatedInvocation("control", ["--readme"])).toBe(false);
        expect(isGatedInvocation("macos", ["reminders", "list", "--readme"])).toBe(false);
    });

    // Regression test: PR #456 review round 6 — `tools macos control <cmd>` runs the same control
    // tool as `tools control <cmd>`, so it needs the same build offer
    it("gates the macos control delegation like tools control", () => {
        expect(isGatedInvocation("macos", ["control", "see", "--app", "Finder"])).toBe(true);
        expect(isGatedInvocation("macos", ["control", "doctor"])).toBe(false);
        expect(isGatedInvocation("macos", ["control"])).toBe(false);
    });

    // Regression test: PR #456 review round 4 — a bare area prints Commander's help, so it must not offer a build
    it("does not gate a bare macos area with no subcommand", () => {
        expect(isGatedInvocation("macos", ["calendar"])).toBe(false);
        expect(isGatedInvocation("macos", ["reminders", "--json"])).toBe(false);
        expect(isGatedInvocation("macos", ["calendar", "list"])).toBe(true);
    });

    // Regression test: PR #456 review — a read-only word matched anywhere, so an option value suppressed the offer
    it("gates a control command whose option value is a read-only word", () => {
        expect(isGatedInvocation("control", ["see", "--app", "status"])).toBe(true);
        expect(isGatedInvocation("control", ["-v", "click", "--app", "doctor"])).toBe(true);
    });

    it("gates a macos subcommand whose option value is a read-only word", () => {
        expect(isGatedInvocation("macos", ["reminders", "list", "--list", "doctor"])).toBe(true);
    });

    it("still skips a read-only subcommand after a leading global flag", () => {
        expect(isGatedInvocation("control", ["-v", "doctor"])).toBe(false);
        expect(isGatedInvocation("macos", ["calendar", "doctor", "--json"])).toBe(false);
    });

    it("does not gate bare control, which prints its help", () => {
        expect(isGatedInvocation("control", [])).toBe(false);
    });

    // Regression test: Fable judge J7 — hub builds the app on its own, so a "no" here would be ignored.
    it("does not gate hub", () => {
        expect(isGatedInvocation("hub", ["status"])).toBe(false);
    });

    it.each([["calendar"], ["reminders"], ["mail"], ["messages"], ["voice-memos"]])("gates macos %s", (subcommand) => {
        expect(isGatedInvocation("macos", [subcommand, "list"])).toBe(true);
    });

    it.each([["calendar"], ["reminders"]])("does not gate macos %s doctor", (subcommand) => {
        expect(isGatedInvocation("macos", [subcommand, "doctor"])).toBe(false);
    });

    it("does not gate macos permissions, which manages the app itself", () => {
        expect(isGatedInvocation("macos", ["permissions", "status"])).toBe(false);
    });

    it("does not gate an unlisted macos subcommand", () => {
        expect(isGatedInvocation("macos", ["swap"])).toBe(false);
    });

    it("does not gate bare macos with no subcommand", () => {
        expect(isGatedInvocation("macos", [])).toBe(false);
    });

    it("does not gate an unrelated tool", () => {
        expect(isGatedInvocation("ask", [])).toBe(false);
    });
});

describe("createRealBuildOfferDeps", () => {
    function stubTty(stdin: boolean, stdout: boolean): () => void {
        const before = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
        Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true, writable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true, writable: true });

        return () => {
            Object.defineProperty(process.stdin, "isTTY", { value: before.stdin, configurable: true, writable: true });
            Object.defineProperty(process.stdout, "isTTY", {
                value: before.stdout,
                configurable: true,
                writable: true,
            });
        };
    }

    // Regression test: Fable judge J2 — `tools control see … | jq` must never get the offer on its stdout.
    it("is not a terminal when stdout is piped, even with a terminal on stdin", () => {
        const restore = stubTty(true, false);

        try {
            expect(createRealBuildOfferDeps().isTty()).toBe(false);
        } finally {
            restore();
        }
    });

    it("is a terminal when both stdin and stdout are terminals", () => {
        const restore = stubTty(true, true);

        try {
            expect(createRealBuildOfferDeps().isTty()).toBe(true);
        } finally {
            restore();
        }
    });

    it("writes its messages to stderr", () => {
        const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

        try {
            createRealBuildOfferDeps().log("hello from the offer");

            expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("hello from the offer");
        } finally {
            stderr.mockRestore();
        }
    });
});

describe("shouldAsk", () => {
    const now = 1_700_000_000_000;

    it("asks when nothing was ever declined", () => {
        expect(shouldAsk(undefined, now)).toBe(true);
    });

    it("stays quiet inside the cooldown window", () => {
        expect(shouldAsk(now - DECLINE_COOLDOWN_MS + 1, now)).toBe(false);
    });

    it("asks again once the cooldown has fully elapsed", () => {
        expect(shouldAsk(now - DECLINE_COOLDOWN_MS, now)).toBe(true);
    });
});

describe("readOfferStateFrom / writeOfferStateTo", () => {
    function tempStatePath(): string {
        return join(mkdtempSync(join(tmpdir(), "build-offer-test-")), "state.json");
    }

    it("round-trips a written timestamp", () => {
        const path = tempStatePath();
        writeOfferStateTo(path, { declinedAtMs: 1_234_567 });

        expect(readOfferStateFrom(path).declinedAtMs).toBe(1_234_567);
    });

    it("keeps the decline and the Xcode notice apart in one file", () => {
        const path = tempStatePath();
        writeOfferStateTo(path, { declinedAtMs: 1_000 });
        writeOfferStateTo(path, { xcodeNoticeAtMs: 2_000 });

        expect(readOfferStateFrom(path)).toEqual({ declinedAtMs: 1_000, xcodeNoticeAtMs: 2_000 });
    });

    it("reads nothing when no state file exists yet", () => {
        expect(readOfferStateFrom(tempStatePath())).toEqual({});
    });
});

const NOW = 1_700_000_000_000;

interface FakeDepsOverrides {
    noAppEnv?: boolean;
    isTty?: boolean;
    isAppBuilt?: boolean;
    declinedAt?: number;
    xcodeNoticeAt?: number;
    toolchain?: { kind: "xcode" | "command-line-tools" | "none"; developerDir?: string };
    confirmAnswer?: boolean;
}

/** Every call that reaches a dep is logged, so an override still shows up in `calls` even though its return value changed. */
function fakeDeps(overrides: FakeDepsOverrides = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps = {
        isTty: () => overrides.isTty ?? true,
        noAppEnv: () => overrides.noAppEnv ?? false,
        isAppBuilt: () => overrides.isAppBuilt ?? false,
        detectToolchain: () =>
            (overrides.toolchain ?? {
                kind: "xcode",
                developerDir: "/Applications/Xcode.app/Contents/Developer",
            }) as ReturnType<BuildOfferDeps["detectToolchain"]>,
        readDeclinedAt: () => overrides.declinedAt,
        writeDeclinedAt: (atMs: number) => {
            calls.push(`writeDeclinedAt:${atMs}`);
        },
        readXcodeNoticeAt: () => overrides.xcodeNoticeAt,
        writeXcodeNoticeAt: (atMs: number) => {
            calls.push(`writeXcodeNoticeAt:${atMs}`);
        },
        confirmBuild: async () => {
            calls.push("confirmBuild");
            return overrides.confirmAnswer ?? true;
        },
        build: async (onStep: (message: string) => void) => {
            calls.push("build");
            onStep("building");
        },
        log: (message: string) => {
            calls.push("log");
            logs.push(message);
        },
        now: () => NOW,
    };

    return { deps, calls, logs };
}

describe("maybeOfferGenesisAppBuild", () => {
    it("asks nothing when GENESIS_TOOLS_NO_APP is set", async () => {
        const { deps, calls } = fakeDeps({ noAppEnv: true });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks nothing without a TTY", async () => {
        const { deps, calls } = fakeDeps({ isTty: false });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks nothing once the app is already built", async () => {
        const { deps, calls } = fakeDeps({ isAppBuilt: true });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks nothing while a decline is still inside its cooldown", async () => {
        const { deps, calls } = fakeDeps({ declinedAt: NOW - 1000 });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    // Regression test: PR #456 review — the Xcode notice was stored as a decline, so installing Xcode
    // did not bring the offer back for 3 days
    it("prints the Xcode hint and records the notice, not a decline, without full Xcode", async () => {
        const { deps, calls, logs } = fakeDeps({
            toolchain: { kind: "command-line-tools", developerDir: "/Library/Developer/CommandLineTools" },
        });
        await maybeOfferGenesisAppBuild(deps);

        expect(logs[0]).toContain("needs the full Xcode");
        expect(calls).toEqual(["log", `writeXcodeNoticeAt:${NOW}`]);
    });

    it("does not repeat the Xcode notice inside its cooldown", async () => {
        const { deps, calls } = fakeDeps({
            xcodeNoticeAt: NOW - 1000,
            toolchain: { kind: "command-line-tools", developerDir: "/Library/Developer/CommandLineTools" },
        });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual([]);
    });

    it("asks as soon as Xcode is installed, even right after the Xcode notice", async () => {
        const { deps, calls } = fakeDeps({ xcodeNoticeAt: NOW - 1000 });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual(["log", "confirmBuild", "build", "log"]);
    });

    it("records a decline and never builds when the answer is no", async () => {
        const { deps, calls } = fakeDeps({ confirmAnswer: false });
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual(["log", "confirmBuild", `writeDeclinedAt:${NOW}`]);
    });

    it("builds and never records a decline when the answer is yes", async () => {
        const { deps, calls } = fakeDeps();
        await maybeOfferGenesisAppBuild(deps);

        expect(calls).toEqual(["log", "confirmBuild", "build", "log"]);
    });

    it("never throws when the build itself fails, so the original command still runs after", async () => {
        const { deps, calls, logs } = fakeDeps();
        deps.build = async () => {
            calls.push("build");
            throw new Error("swift build failed");
        };

        await expect(maybeOfferGenesisAppBuild(deps)).resolves.toBeUndefined();

        expect(calls).toEqual(["log", "confirmBuild", "build", "log"]);
        expect(logs.at(-1)).toContain("swift build failed");
    });
});
