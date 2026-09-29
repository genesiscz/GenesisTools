import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { GenesisAppUpdatingError } from "@genesiscz/utils/macos/genesis-app";
import { buildPidRecord, serializePidRecord } from "@genesiscz/utils/process/pidfile";
import { skip } from "@genesiscz/utils/test/skip";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { NativeControlSession } from "./decision/native-session";
import { emitClickOverlay } from "./overlay";
import {
    type AxRunBoundary,
    axCommandLine,
    DEFAULT_AX_RUN_BOUNDARY,
    ensureBinary,
    getBinaryPath,
    REAL_AX_TOOL_IN_TESTS,
    RealMachineInTestError,
    runAx,
    runAxAsync,
    runAxAsyncWithRecovery,
    runAxWithBoundary,
    withNativeBudget,
} from "./runner";

test("a build failure never reaches the native spawn boundary", () => {
    let spawnCalls = 0;
    const boundary: AxRunBoundary = {
        ensureBinary: () => {
            throw new Error("fixture build unavailable");
        },
        spawn: () => {
            spawnCalls++;
            throw new Error("spawn must stay unreachable");
        },
    };

    const result = runAxWithBoundary({ args: ["see", "--app", "Fixture"], boundary });

    expect(result).toEqual({ ok: false, error: "fixture build unavailable" });
    expect(spawnCalls).toBe(0);
});

test("a subprocess timeout reports a partial outcome without retrying", () => {
    let spawnCalls = 0;
    const timeout = Object.assign(new Error("spawnSync fixture ETIMEDOUT"), { code: "ETIMEDOUT" });
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => {
            spawnCalls++;
            return { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: timeout };
        },
    };

    const result = runAxWithBoundary({ args: ["act"], timeoutMs: 25, boundary });

    expect(result).toEqual({
        ok: false,
        error: "native execution timed out after 25ms; the action may have partially completed; no retry was attempted",
    });
    expect(spawnCalls).toBe(1);
});

test("a paste stopped at the deadline keeps only the clipboard status it printed on the way out", () => {
    const timeout = Object.assign(new Error("fixture ETIMEDOUT"), { code: "ETIMEDOUT" });
    const printed = '{"ok":false,"dispatchState":"dispatched","clipboardRestore":"restored"}';
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => ({ status: null, signal: "SIGTERM", stdout: `${printed}\n`, stderr: "", error: timeout }),
    };

    const result = runAxWithBoundary({ args: ["act"], timeoutMs: 25, boundary });

    expect(result).toEqual({
        ok: false,
        error: "native execution timed out after 25ms; the action may have partially completed; no retry was attempted",
        clipboardRestore: "restored",
    });
});

test("a signaled subprocess overrides a success envelope as a partial outcome", () => {
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => ({
            status: null,
            signal: "SIGKILL",
            stdout: '{"ok":true,"pid":4321}',
            stderr: "",
        }),
    };

    const result = runAxWithBoundary({ args: ["act"], boundary });

    expect(result).toEqual({
        ok: false,
        pid: 4321,
        error: "native command terminated by SIGKILL; the action may have partially completed; no retry was attempted",
    });
});

test("an output budget failure names the 32 MiB limit and partial outcome", () => {
    const overflow = Object.assign(new Error("spawnSync fixture ENOBUFS"), { code: "ENOBUFS" });
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => ({
            status: null,
            signal: "SIGTERM",
            stdout: '{"ok":true',
            stderr: "",
            error: overflow,
        }),
    };

    const result = runAxWithBoundary({ args: ["see"], boundary });

    expect(result).toEqual({
        ok: false,
        error: "native output exceeded the 32 MiB per-stream budget; the command may have partially completed; no retry was attempted",
    });
});

test("parsed native envelopes require an object with boolean ok", () => {
    for (const stdout of ["42", "null", '{"pid":4321}', '{"ok":"yes"}']) {
        const boundary: AxRunBoundary = {
            ensureBinary: () => "/fixture/ax-tool",
            spawn: () => ({ status: 0, signal: null, stdout, stderr: "" }),
        };

        expect(runAxWithBoundary({ args: ["see"], boundary })).toEqual({
            ok: false,
            error: `invalid native result envelope: ${stdout.slice(0, 200)}`,
        });
    }
});

test("a generic spawn error reports the partial outcome without retrying", () => {
    let spawnCalls = 0;
    const denied = Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => {
            spawnCalls++;
            return { status: null, signal: null, stdout: "", stderr: "", error: denied };
        },
    };

    const result = runAxWithBoundary({ args: ["act"], boundary });

    expect(result).toEqual({
        ok: false,
        error: "native execution failed: fixture permission denied; the action may have partially completed; no retry was attempted",
    });
    expect(spawnCalls).toBe(1);
});

test("malformed and strict-invalid JSON are rejected", () => {
    for (const stdout of ["{broken", '{"ok":true,}']) {
        const boundary: AxRunBoundary = {
            ensureBinary: () => "/fixture/ax-tool",
            spawn: () => ({ status: 0, signal: null, stdout, stderr: "" }),
        };

        expect(runAxWithBoundary({ args: ["see"], boundary })).toEqual({
            ok: false,
            error: `invalid JSON: ${stdout}`,
        });
    }
});

test("a nonzero exit overrides a success envelope", () => {
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => ({
            status: 7,
            signal: null,
            stdout: '{"ok":true,"pid":4321}',
            stderr: "fixture failure",
        }),
    };

    expect(runAxWithBoundary({ args: ["see"], boundary })).toEqual({
        ok: false,
        pid: 4321,
        error: "native command exited 7",
    });
});

test("an ordinary successful envelope is returned unchanged", () => {
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => ({
            status: 0,
            signal: null,
            stdout: '{"ok":true,"pid":4321,"windowId":987}',
            stderr: "",
        }),
    };

    expect(runAxWithBoundary({ args: ["see"], boundary })).toEqual({
        ok: true,
        pid: 4321,
        windowId: 987,
    });
});

test("a launcher replacement refusal is pre-dispatch and never retries", () => {
    let attempts = 0;
    const result = runAxWithBoundary({
        args: ["act"],
        boundary: {
            ensureBinary: () => "/fixture/ax-tool",
            spawn: () => {
                attempts++;
                throw new GenesisAppUpdatingError("/fixture/build.lock");
            },
        },
    });
    expect(result).toMatchObject({ ok: false, dispatchState: "not_started", refusal: "launcher_updating" });
    expect(attempts).toBe(1);
});

test.skipIf(skip.unlessMac)(
    "only a live bundle swap refuses a native command: never a build in progress, never a swap whose owner is gone",
    async () => {
        const taskHome = mkdtempSync(join(tmpdir(), "gt-ax-update-"));
        const appDir = join(taskHome, ".genesis-tools", "app");
        mkdirSync(appDir, { recursive: true });
        const marker = join(appDir, "install.lock");
        const live = serializePidRecord(buildPidRecord());
        writeFileSync(join(appDir, "build.lock"), live);
        writeFileSync(marker, live);
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: taskHome, GENESIS_TOOLS_NO_APP: undefined }, () => {
            expect(() => axCommandLine("/fixture/ax-tool", ["permissions"])).toThrow(GenesisAppUpdatingError);
            expect(readFileSync(marker, "utf8")).toBe(live);
            const dir = join(taskHome, "Applications", "GenesisTools.app", "Contents", "MacOS");
            mkdirSync(dir, { recursive: true });
            const launcher = join(dir, "GenesisTools");
            writeFileSync(launcher, "");
            const launched = [launcher, "/fixture/ax-tool", "permissions"];
            expect(() => axCommandLine("/fixture/ax-tool", ["permissions"])).toThrow(GenesisAppUpdatingError);

            unlinkSync(marker);
            expect(axCommandLine("/fixture/ax-tool", ["permissions"])).toEqual(launched);

            const gone = { pid: 2_147_483_000, command: "gone", startedAt: null, writtenAt: Date.now() };
            writeFileSync(marker, serializePidRecord(gone));
            expect(axCommandLine("/fixture/ax-tool", ["permissions"])).toEqual(launched);

            writeFileSync(marker, "");
            expect(() => axCommandLine("/fixture/ax-tool", ["permissions"])).toThrow(GenesisAppUpdatingError);
            const anHourAgo = new Date(Date.now() - 3_600_000);
            utimesSync(marker, anHourAgo, anHourAgo);
            expect(axCommandLine("/fixture/ax-tool", ["permissions"])).toEqual(launched);
        });
    }
);

test("the real subprocess boundary accepts valid native JSON larger than one MiB", () => {
    const payloadBytes = 2 * 1024 * 1024;
    const boundary: AxRunBoundary = {
        ...DEFAULT_AX_RUN_BOUNDARY,
        ensureBinary: () => process.execPath,
    };
    const script = `process.stdout.write(JSON.stringify({ ok: true, payload: "x".repeat(${payloadBytes}) }))`;

    const result = runAxWithBoundary({ args: ["-e", script], boundary });

    expect(result.ok).toBe(true);
    expect(typeof result.payload).toBe("string");
    if (typeof result.payload !== "string") {
        throw new Error("expected string payload");
    }

    expect(result.payload.length).toBe(payloadBytes);
});

test("an exit with no stdout surfaces trimmed stderr", () => {
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => ({ status: 3, signal: null, stdout: "", stderr: "  fixture stderr  " }),
    };

    expect(runAxWithBoundary({ args: ["see"], boundary })).toEqual({ ok: false, error: "fixture stderr" });
});

test.skipIf(skip.unlessMac)("axCommandLine prepends the installed launcher, not the spawn-time one", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-ax-home-"));
    const dir = join(home, "Applications", "GenesisTools.app", "Contents", "MacOS");
    mkdirSync(dir, { recursive: true });
    const launcher = join(dir, "GenesisTools");
    writeFileSync(launcher, "");

    await env.testing.withOverrides(
        {
            GENESIS_TOOLS_APP_BUNDLE_ID: "com.genesiscz.genesistools",
            GENESIS_TOOLS_NO_APP: undefined,
            GENESIS_TOOLS_HOME: home,
        },
        () => {
            expect(axCommandLine("/fixture/ax-tool", ["see", "--app", "Fixture"])).toEqual([
                launcher,
                "/fixture/ax-tool",
                "see",
                "--app",
                "Fixture",
            ]);
        }
    );
});

test.skipIf(skip.unlessMac)("axCommandLine stays bare when no launcher is installed", async () => {
    await env.testing.withOverrides(
        {
            GENESIS_TOOLS_APP_BUNDLE_ID: undefined,
            GENESIS_TOOLS_NO_APP: undefined,
            GENESIS_TOOLS_HOME: "/nonexistent",
        },
        () => {
            expect(axCommandLine("/fixture/ax-tool", ["see"])).toEqual(["/fixture/ax-tool", "see"]);
        }
    );
});

test("a native error message survives a nonzero exit", () => {
    const boundary: AxRunBoundary = {
        ensureBinary: () => "/fixture/ax-tool",
        spawn: () => ({
            status: 4,
            signal: null,
            stdout: '{"ok":false,"error":"snapshot token expired"}',
            stderr: "",
        }),
    };

    expect(runAxWithBoundary({ args: ["act"], boundary })).toEqual({ ok: false, error: "snapshot token expired" });
});

test("native deadlines round down to subprocess milliseconds and never become unlimited", () => {
    let builds = 0;
    const observedTimeouts: number[] = [];
    const boundary: AxRunBoundary = {
        ensureBinary: () => {
            builds++;
            return "/fixture/ax-tool";
        },
        spawn: (options) => {
            observedTimeouts.push(options.timeoutMs);
            return { status: 0, signal: null, stdout: '{"ok":true}', stderr: "" };
        },
    };
    expect(runAxWithBoundary({ args: ["see"], timeoutMs: 29999.798708, boundary }).ok).toBe(true);
    expect(observedTimeouts).toHaveLength(1);
    expect(observedTimeouts[0]).toBeGreaterThan(0);
    expect(observedTimeouts[0]).toBeLessThanOrEqual(29999);
    for (const timeoutMs of [0.4, 0, -1, Infinity, NaN, 2147483648]) {
        expect(runAxWithBoundary({ args: ["act"], timeoutMs, boundary })).toMatchObject({
            ok: false,
            dispatchState: "not_started",
        });
    }
    expect(builds).toBe(1);
    expect(observedTimeouts).toHaveLength(1);
});
test("see and act carry the attempt's deadline to the native side, other commands do not", () => {
    expect(withNativeBudget(["act", "--app", "Fixture"], 9876.5)).toEqual([
        "act",
        "--app",
        "Fixture",
        "--budget-ms",
        "9876",
    ]);
    expect(withNativeBudget(["see", "--app", "Fixture"], 20)).toEqual([
        "see",
        "--app",
        "Fixture",
        "--budget-ms",
        "100",
    ]);
    expect(withNativeBudget(["window", "--app", "Fixture"], 9000)).toEqual(["window", "--app", "Fixture"]);
    expect(withNativeBudget(["act", "--budget-ms", "500"], 9000)).toEqual(["act", "--budget-ms", "500"]);
});

test("a throwing spawn is reported as uncertain and never retried", () => {
    let spawns = 0;
    const result = runAxWithBoundary({
        args: ["act"],
        boundary: {
            ensureBinary: () => "/fixture/ax-tool",
            spawn: () => {
                spawns++;
                throw new Error("Lost transport");
            },
        },
    });
    expect(result).toMatchObject({ ok: false, dispatchState: "uncertain" });
    expect(spawns).toBe(1);
});

test("prepared recovery resumes only the refused action and keeps its original arguments", () => {
    const args = ["act", "--snapshot", "original", "--prepare", "--target-key", "a".repeat(64)];
    let attempts = 0;
    const timeouts: number[] = [];
    const result = runAxWithBoundary({
        args,
        timeoutMs: 8000,
        boundary: {
            ensureBinary: () => "/fixture/ax-tool",
            spawn: (call) => {
                // The same token and target key every time; only the attempt's own deadline differs.
                expect(call.args).toEqual([...args, "--budget-ms", String(call.timeoutMs)]);
                timeouts.push(call.timeoutMs);
                attempts++;
                return {
                    status: attempts === 1 ? 1 : 0,
                    signal: null,
                    stderr: "",
                    stdout:
                        attempts === 1
                            ? '{"ok":false,"dispatchState":"not_started","refusal":"stale_observation"}'
                            : '{"ok":true,"dispatchState":"dispatched"}',
                };
            },
        },
    });
    expect(result).toMatchObject({ ok: true, recovery: { retries: 1, refusals: ["stale_observation"] } });
    expect(attempts).toBe(2);
    expect(timeouts[1]).toBeLessThanOrEqual(timeouts[0]);
});

test("prepared recovery refuses unsafe states and cannot loop forever", async () => {
    const args = ["act", "--prepare", "--target-key", "a".repeat(64)];
    for (const dispatchState of ["uncertain", "dispatched", undefined]) {
        let calls = 0;
        await runAxAsyncWithRecovery({
            args,
            timeoutMs: 2000,
            run: async () => {
                calls++;
                return { ok: false, dispatchState, refusal: "stale_observation" };
            },
        });
        expect(calls).toBe(1);
    }
    for (const refusal of [
        "scope_changed",
        "missing_target",
        "permission",
        "refused",
        "launcher_updating",
        "user_takeover",
    ]) {
        let calls = 0;
        await runAxAsyncWithRecovery({
            args,
            timeoutMs: 2000,
            run: async () => {
                calls++;
                return { ok: false, dispatchState: "not_started", refusal };
            },
        });
        expect(calls).toBe(1);
    }
    for (const unsafeArgs of [["act"], ["see"], [...args, "--coords", "1,2"], [...args, "--region", "r1"]]) {
        let calls = 0;
        await runAxAsyncWithRecovery({
            args: unsafeArgs,
            timeoutMs: 2000,
            run: async () => {
                calls++;
                return { ok: false, dispatchState: "not_started", refusal: "stale_observation" };
            },
        });
        expect(calls).toBe(1);
    }
    let calls = 0;
    const exhausted = await runAxAsyncWithRecovery({
        args,
        timeoutMs: 2000,
        run: async () => {
            calls++;
            return { ok: false, dispatchState: "not_started", refusal: "focus_mismatch" };
        },
    });
    expect(calls).toBe(3);
    expect(exhausted).toMatchObject({ ok: false, recovery: { retries: 2 } });
    const controller = new AbortController();
    calls = 0;
    await runAxAsyncWithRecovery({
        args,
        timeoutMs: 2000,
        signal: controller.signal,
        run: async () => {
            calls++;
            controller.abort();
            return { ok: false, dispatchState: "not_started", refusal: "stale_observation" };
        },
    });
    expect(calls).toBe(1);
});

test("a retry that finds the target changed reports uncertain delivery and names every attempt", async () => {
    const args = ["act", "--prepare", "--target-key", "a".repeat(64)];
    const replies = [
        {
            ok: false,
            dispatchState: "not_started",
            refusal: "focus_mismatch",
            error: 'focus changed before input; no action dispatched; focus is on AXList "Suggestions", not the target',
        },
        {
            ok: false,
            dispatchState: "not_started",
            refusal: "missing_target",
            error: "observed target changed, disappeared or became ambiguous",
        },
    ];
    let calls = 0;
    const result = await runAxAsyncWithRecovery({
        args,
        timeoutMs: 2000,
        run: async () => {
            const reply = replies[calls++];
            if (!reply) {
                throw new Error("The input was attempted a third time");
            }

            return reply;
        },
    });
    expect(calls).toBe(2);
    expect(result.dispatchState).toBe("uncertain");
    expect(result.recovery).toMatchObject({ retries: 1, targetChanged: true });
    expect(result.error).toContain(
        'attempt 1: focus changed before input; no action dispatched; focus is on AXList "Suggestions"'
    );
    expect(result.error).toContain("attempt 2: observed target changed");
    expect(result.error).toContain("Observe before repeating the input.");

    // The negative control: one refusal, no preparation retried, stays an honest not_started.
    const single = await runAxAsyncWithRecovery({
        args,
        timeoutMs: 2000,
        run: async () => ({ ok: false, dispatchState: "not_started", refusal: "missing_target", error: "gone" }),
    });
    expect(single.dispatchState).toBe("not_started");
    expect(single.error).toBe("gone");
});

test("a user takeover ends a recovering call on the attempt it arrives and keeps its own dispatch state", async () => {
    const args = ["act", "--prepare", "--target-key", "a".repeat(64)];
    const replies = [
        { ok: false, dispatchState: "not_started", refusal: "stale_observation", error: "UI changed" },
        { ok: false, dispatchState: "uncertain", refusal: "user_takeover", error: "the user took over" },
    ];
    let calls = 0;
    const result = await runAxAsyncWithRecovery({
        args,
        timeoutMs: 2000,
        run: async () => {
            const reply = replies[calls++];
            if (!reply) {
                throw new Error("The input was attempted after the user took over");
            }

            return reply;
        },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({
        ok: false,
        dispatchState: "uncertain",
        refusal: "user_takeover",
        error: "the user took over",
        recovery: { retries: 1 },
    });

    // The negative control: the same prepared call is still retried for an ordinary stale refusal.
    calls = 0;
    await runAxAsyncWithRecovery({
        args,
        timeoutMs: 2000,
        run: async () => {
            calls++;
            return calls === 1
                ? { ok: false, dispatchState: "not_started", refusal: "stale_observation" }
                : { ok: true, dispatchState: "dispatched" };
        },
    });
    expect(calls).toBe(2);
});

test("terminated native refusal cannot authorize an action retry", () => {
    let calls = 0;
    const result = runAxWithBoundary({
        args: ["act", "--prepare", "--target-key", "a".repeat(64)],
        boundary: {
            ensureBinary: () => "/fixture/ax-tool",
            spawn: () => {
                calls++;
                return {
                    status: null,
                    signal: "SIGTERM",
                    stderr: "",
                    stdout: '{"ok":false,"dispatchState":"not_started","refusal":"stale_observation"}',
                };
            },
        },
    });
    expect(result.dispatchState).toBe("uncertain");
    expect(calls).toBe(1);
});

test("async recovery retains earlier refusal when transport is lost and never repeats unknown input", async () => {
    let calls = 0;
    const args = ["act", "--prepare", "--target-key", "a".repeat(64)];
    const result = await runAxAsyncWithRecovery({
        args,
        timeoutMs: 2000,
        run: async () => {
            calls++;
            if (calls === 1) {
                return { ok: false, dispatchState: "not_started", refusal: "stale_observation" };
            }
            throw new Error("fixture lost transport");
        },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: false, dispatchState: "uncertain", recovery: { retries: 1 } });
    calls = 0;
    await runAxAsyncWithRecovery({
        args,
        timeoutMs: 0,
        run: async () => {
            calls++;
            throw new Error("expired deadline must not dispatch");
        },
    });
    expect(calls).toBe(0);
});

// The guard's own proof, ported from typesafe-computer-use `tests/test_no_real_machine.py`. Each
// test first proves the door it relies on refuses, so a regressed guard fails there, before a
// later call could reach the real ax-tool. Every probe passes an argument ax-tool does not know.
test("under test the real ax-tool is never handed out, built or spawned", () => {
    expect(isTestProcess()).toBe(true);
    expect(() => ensureBinary()).toThrow(RealMachineInTestError);
    expect(() => ensureBinary()).toThrow(/^a test reached the real machine through ax-tool/);
    expect(() => axCommandLine(getBinaryPath(), ["guard-probe", "--app", "Fixture"])).toThrow(
        "a test reached the real machine through ax-tool guard-probe --app Fixture"
    );
});

test("every entry point throws the refusal instead of folding it into an ok:false result", async () => {
    expect(() => ensureBinary()).toThrow(RealMachineInTestError);

    expect(() => runAx(["guard-probe"])).toThrow(RealMachineInTestError);
    await expect(runAxAsync({ args: ["guard-probe"] })).rejects.toThrow(RealMachineInTestError);
    expect(() => runAxWithBoundary({ args: ["guard-probe"], boundary: DEFAULT_AX_RUN_BOUNDARY })).toThrow(
        RealMachineInTestError
    );
    expect(() => new NativeControlSession({ app: "Fixture" })).toThrow(RealMachineInTestError);
    // The overlay draws on the real screen; it used to swallow every failure into `false`.
    expect(() => emitClickOverlay({ x: 100, y: 100 })).toThrow(RealMachineInTestError);
});

test("the spawn door refuses the real binary even when an injected boundary hands it out", async () => {
    expect(() => axCommandLine(getBinaryPath(), ["guard-probe"])).toThrow(RealMachineInTestError);

    const handsOutTheRealBinary: AxRunBoundary = { ...DEFAULT_AX_RUN_BOUNDARY, ensureBinary: getBinaryPath };
    expect(() => runAxWithBoundary({ args: ["guard-probe"], boundary: handsOutTheRealBinary })).toThrow(
        RealMachineInTestError
    );
    // A recovering call must not report the refusal as an uncertain transport failure either.
    await expect(
        runAxAsyncWithRecovery({
            args: ["guard-probe"],
            timeoutMs: 2000,
            run: async () => {
                axCommandLine(getBinaryPath(), ["guard-probe"]);
                return { ok: true };
            },
        })
    ).rejects.toThrow(RealMachineInTestError);
});

test("a fixture binary, an injected transport and the explicit opt-in still pass (negative control)", async () => {
    // A fixture binary through the real spawn is covered end to end by "the real subprocess
    // boundary accepts valid native JSON larger than one MiB" above: it spawns process.execPath.
    expect(axCommandLine("/fixture/ax-tool", ["see"]).slice(-2)).toEqual(["/fixture/ax-tool", "see"]);

    const transport = {
        request: async () => ({ ok: true }),
        close: () => {},
    };
    expect(() => new NativeControlSession({ app: "Fixture", transport })).not.toThrow();

    await env.testing.withOverrides({ [REAL_AX_TOOL_IN_TESTS]: "1" }, () => {
        expect(axCommandLine(getBinaryPath(), ["see"]).slice(-2)).toEqual([getBinaryPath(), "see"]);
    });
    expect(() => axCommandLine(getBinaryPath(), ["see"])).toThrow(RealMachineInTestError);
});

test("peekaboo's own spawns, which bypass runner.ts, refuse under test too", async () => {
    const { runCmd, runCmdFull, runPeekabooJson } = await import("./peekaboo");
    expect(() => runCmd(["osascript", "-e", "guard-probe"])).toThrow(RealMachineInTestError);
    expect(() => runCmdFull([getBinaryPath(), "guard-probe"])).toThrow(RealMachineInTestError);
    expect(() => runPeekabooJson(["guard-probe"])).toThrow(RealMachineInTestError);
});
