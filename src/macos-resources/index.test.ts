import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test: #446 item 4 — `tools macos-resources` without a TTY crashed
// with Ink's full "Raw mode is not supported" React/reconciler stack instead of
// one clear line.
describe("tools macos-resources: non-interactive stdin", () => {
    // The unfixed code runs one 5s refresh cycle before Ink's own cleanup lets the
    // process exit; the default 5000ms bun:test timeout fires first and masks the
    // real failure as a timeout instead of a content mismatch, hence 10_000 below.
    it("prints one line and exits 1 instead of crashing with an Ink stack", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-macos-resources-home-"));
        try {
            const proc = Bun.spawn({
                cmd: ["bun", "run", join(import.meta.dir, "index.tsx")],
                cwd: import.meta.dir,
                env: { ...process.env, GENESIS_TOOLS_HOME: home, NO_COLOR: "1" },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            const combined = `${stdout}${stderr}`;

            expect(exitCode).toBe(1);
            expect(combined).toContain("needs an interactive terminal");
            expect(combined).not.toContain("Raw mode is not supported");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 10_000);
});
