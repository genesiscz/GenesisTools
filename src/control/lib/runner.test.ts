import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { GenesisAppUpdatingError } from "@genesiscz/utils/macos/genesis-app";
import { skip } from "@genesiscz/utils/test/skip";
import {
    type AxRunBoundary,
    axCommandLine,
    DEFAULT_AX_RUN_BOUNDARY,
    runAxAsyncWithRecovery,
    runAxWithBoundary,
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
    "launcher replacement never falls back to a bare native binary or removes the build lock",
    async () => {
        const taskHome = mkdtempSync(join(tmpdir(), "gt-ax-update-"));
        const appDir = join(taskHome, ".genesis-tools", "app");
        mkdirSync(appDir, { recursive: true });
        const lock = join(appDir, "build.lock");
        writeFileSync(lock, "fixture-holder");
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: taskHome, GENESIS_TOOLS_NO_APP: undefined }, () => {
            expect(() => axCommandLine("/fixture/ax-tool", ["permissions"])).toThrow(GenesisAppUpdatingError);
            expect(readFileSync(lock, "utf8")).toBe("fixture-holder");
            const dir = join(taskHome, "Applications", "GenesisTools.app", "Contents", "MacOS");
            mkdirSync(dir, { recursive: true });
            const launcher = join(dir, "GenesisTools");
            writeFileSync(launcher, "");
            expect(() => axCommandLine("/fixture/ax-tool", ["permissions"])).toThrow(GenesisAppUpdatingError);
            unlinkSync(lock);
            expect(axCommandLine("/fixture/ax-tool", ["permissions"])).toEqual([
                launcher,
                "/fixture/ax-tool",
                "permissions",
            ]);
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
                expect(call.args).toEqual(args);
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
    for (const refusal of ["scope_changed", "missing_target", "permission", "refused", "launcher_updating"]) {
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
