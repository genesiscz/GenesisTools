import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test: #446 item 4 — `tools claude usage` without a TTY crashed with
// Ink's full "Raw mode is not supported" React/reconciler stack instead of one
// clear line pointing at the command's own non-interactive flags.
describe("tools claude usage: non-interactive stdin", () => {
    it("prints one line pointing to --json/--no-tui instead of crashing with an Ink stack", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-claude-usage-home-"));
        try {
            const proc = Bun.spawn({
                cmd: ["bun", "run", join(import.meta.dir, "../../index.ts"), "usage"],
                cwd: join(import.meta.dir, "../.."),
                env: { ...process.env, GENESIS_TOOLS_HOME: home, NO_COLOR: "1" },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

            expect(exitCode).toBe(1);
            expect(stderr).toContain("needs an interactive terminal");
            expect(stderr).toContain("--json");
            expect(stderr).not.toContain("Raw mode is not supported");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe("tools claude usage: import cost", () => {
    // Regression test: #446 item 4 follow-up — the TTY guard was imported through the Ink barrel,
    // which loads ink, react and react-reconciler at once and undid the deferred TUI import
    // (~160 ms on every `tools claude usage --json`).
    it("loading the usage command does not load ink", async () => {
        const probe = [
            `await import("${join(import.meta.dir, "index.tsx")}");`,
            `console.log(Object.keys(require.cache).some((path) => path.includes("/node_modules/ink/")));`,
        ].join("\n");
        const proc = Bun.spawn({
            cmd: ["bun", "-e", probe],
            cwd: join(import.meta.dir, "../.."),
            env: process.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe("false");
    });
});
