import { expect, test } from "bun:test";
import { type AxRunBoundary, DEFAULT_AX_RUN_BOUNDARY, runAxWithBoundary } from "./runner";

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
