import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const stashCli = join(import.meta.dir, "index.ts");

async function runCli(args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    const proc = Bun.spawn(["bun", "run", stashCli, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stderr, stdout };
}

describe("stash save CLI validation", () => {
    test("--mode regions without --regions exits 2", async () => {
        const { exitCode, stderr } = await runCli(["save", "my-stash", "--mode", "regions"]);
        expect(exitCode).toBe(2);
        expect(stderr).toContain("--regions");
    });

    test("--regions without --mode exits 2", async () => {
        // Explicit `--mode regions` is required alongside `--regions` — no implicit
        // inference, so callers always acknowledge they're choosing region-filtered mode.
        const { exitCode, stderr } = await runCli(["save", "my-stash", "--regions", "foo"]);
        expect(exitCode).toBe(2);
        expect(stderr).toContain("--mode regions");
    });

    test("--mode all --regions exits 2", async () => {
        const { exitCode, stderr } = await runCli(["save", "my-stash", "--mode", "all", "--regions", "foo"]);
        expect(exitCode).toBe(2);
        expect(stderr).toContain("--regions");
    });

    test("--mode regions --regions foo bar does not exit 2", async () => {
        // Validation passes; saveCommand may exit 1 (not in a git repo) or 0, but never 2.
        const { exitCode } = await runCli(["save", "my-stash", "--mode", "regions", "--regions", "foo", "bar"]);
        expect(exitCode).not.toBe(2);
    });
});
