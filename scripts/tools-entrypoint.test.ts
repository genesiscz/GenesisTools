import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Guards the `tools` dispatcher at the repo root.
 *
 * `TOOL_ALIASES` was an object literal, so `TOOL_ALIASES[scriptId]` resolved
 * keys off `Object.prototype`: `tools constructor` got the `Object` function
 * back, died on `alias.slice`, and reported a bare "unexpected error" instead
 * of reaching the "Tool not found" path. These names cannot fuzzy-match a real
 * tool, so the dispatcher exits rather than opening the interactive picker.
 */
const ROOT = join(import.meta.dir, "..");

function runTools(name: string, ...extraArgs: string[]): { status: number | null; output: string } {
    const result = spawnSync("bun", [join(ROOT, "tools"), name, ...extraArgs], {
        cwd: ROOT,
        encoding: "utf-8",
        env: process.env,
        timeout: 60_000,
    });

    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("tools dispatcher", () => {
    it.each(["constructor", "toString", "hasOwnProperty"])(
        "reports %s as an unknown tool instead of crashing",
        (name) => {
            const { status, output } = runTools(name);

            expect(output).toContain("Tool not found");
            expect(output).not.toContain("unexpected error");
            expect(status).toBe(1);
        }
    );

    it("treats an ordinary unknown name the same way", () => {
        const { status, output } = runTools("zzznotarealtool");

        expect(output).toContain("Tool not found");
        expect(status).toBe(1);
    });

    // Regression test: #446 item 9 — `src/voice-memos/` is a stray README (the real tool moved
    // to `src/macos`), so `tools voice-memos` reported "Tool not found" instead of pointing at
    // the command that actually exists.
    it("points voice-memos at its real home under macos instead of reporting it unknown", () => {
        const { output } = runTools("voice-memos", "--help");

        expect(output).toContain("tools macos voice-memos");
        expect(output).not.toContain("Tool not found");
    });

    it("says a source folder without an entry file has no entry point, instead of 'Tool not found'", () => {
        const { status, output } = runTools("e2e");

        expect(output).toContain("No entry point");
        expect(output).toContain("src/e2e/");
        expect(output).toContain("tools e2e/<file>");
        expect(output).not.toContain("Tool not found");
        expect(status).toBe(1);
    });

    // src/log-viewer has no index.ts, but its scripts run by path, so the message must not say "nothing to run".
    it("still runs a script inside an entry-less folder by path", () => {
        const { status, output } = runTools("log-viewer/session-key");

        expect(output).not.toContain("Tool not found");
        expect(output).not.toContain("No entry point");
        expect(status).toBe(0);
    });

    // Regression test: #446 item 5 — `tools --help` printed "Tool not found: --help" and exited 1.
    it.each(["--help", "-h"])("%s prints usage and the tool list, and exits 0", (flag) => {
        const { status, output } = runTools(flag);

        expect(status).toBe(0);
        expect(output).toContain("Usage:");
        expect(output).toContain("macos");
    });
});

// Regression test: D1 wiring — `tools` loads the build-offer check for a gated tool before it
// dispatches, so a broken import path would fail every `tools control` call. The offer itself
// needs a terminal, which a test never has; its decisions are tested in
// src/macos/lib/permissions/app.test.ts.
describe("gated-tool dispatch", () => {
    it("loads the build-offer check and still runs the tool", () => {
        const { status, output } = runTools("control", "--help");

        expect(status).toBe(0);
        expect(output).toContain("Usage: control");
    });
});

describe("native widget dispatcher", () => {
    it("executes main-guarded tools and propagates command failures", () => {
        const bridge = join(ROOT, "widget-tools");
        const help = spawnSync(process.execPath, [bridge, "video", "--help"], {
            cwd: ROOT,
            encoding: "utf8",
            env: process.env,
            timeout: 10_000,
        });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("frames");
        const invalid = spawnSync(process.execPath, [bridge, "video", "frames", "/fixture/missing.mp4", "--fps", "7"], {
            cwd: ROOT,
            encoding: "utf8",
            env: process.env,
            timeout: 10_000,
        });
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain("--fps");
    });
});
