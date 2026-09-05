import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHomeEnvPatch } from "./drivers/test-env";

/**
 * `tools ai-spend series` enumerated flags, pinned through the real CLI.
 *
 * Spawned rather than unit-called because the defect lived in the seam between
 * the action and `runTool`: an unknown `--sources` threw out of an uncaught
 * `program.parseAsync()`, so the user saw a Bun stack trace with a source
 * excerpt instead of a flag diagnostic. Only a real process shows that.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "src", "ai-spend", "index.ts");

let home: string;
let toolsHome: string;

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function runSeries(...args: string[]): RunResult {
    const proc = Bun.spawnSync({
        cmd: ["bun", "run", CLI, "series", ...args],
        cwd: REPO_ROOT,
        env: { ...process.env, ...agentHomeEnvPatch(), HOME: home, GENESIS_TOOLS_HOME: toolsHome },
        stdin: "ignore",
    });

    return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("ai-spend series enumerated flags", () => {
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ai-spend-flags-home-"));
        toolsHome = mkdtempSync(join(tmpdir(), "ai-spend-flags-gt-"));
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(toolsHome, { recursive: true, force: true });
    });

    test("an unknown --sources value lists the possible ones instead of throwing a stack trace", () => {
        const result = runSeries("--sources", "bad", "--grain", "hour");

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--sources does not accept "bad"');
        expect(result.stderr).toContain("Possible: claude, codex, grok");
        // The regression itself: an uncaught throw naming the function it came from.
        expect(result.stderr).not.toContain("at parseSources");
        expect(result.stdout).toBe("");
    });

    test("an invalid --grain names the value given rather than asking for a missing one", () => {
        const result = runSeries("--grain", "bad");

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--grain does not accept "bad"');
        expect(result.stderr).not.toContain("--grain requires a value");
    });

    test("a bare --grain still reports a MISSING value, so the two cases stay distinguishable", () => {
        const result = runSeries("--grain");

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--grain requires a value");
    });

    test("negative control: a valid --grain and --sources still produce a series", () => {
        const result = runSeries("--grain", "day", "--sources", "claude", "--json");

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('"points"');
    });
});
