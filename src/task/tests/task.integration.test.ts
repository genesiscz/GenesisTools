import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskJsonl, runTaskCapture, runTaskCli } from "@app/task/lib/test-harness";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
    }
});

describe("task integration", () => {
    it("captures both streams with monotonic seq and per-stream FIFO order", async () => {
        // Reviewer t12: asserting a hard cross-stream interleaving (OUT1,
        // OUT2, ERR1) is flaky in pipe mode because the capture multiplexes
        // stdout/stderr via concurrent reads + Promise.race. The OS pipe
        // buffer, scheduler, and Bun's read coalescing can legitimately
        // reorder ERR1 to land between OUT1 and OUT2 (or together).
        //
        // What we DO want to verify in this integration test:
        //   - both streams are captured, attributed correctly, and present
        //   - seq numbers are strictly monotonic from 1
        //   - per-stream FIFO is preserved (stdout's OUT1 < OUT2; ERR1
        //     appears exactly once)
        // — independent of the cross-stream interleaving.
        const homeDir = mkdtempSync(join(tmpdir(), "task-int-"));
        dirs.push(homeDir);
        const session = `test-order-${Date.now()}`;
        const code = await runTaskCapture({
            session,
            noTty: true,
            homeDir,
            command: [
                "bun",
                "-e",
                "import{writeSync}from'node:fs';writeSync(1,'OUT1\\n');writeSync(2,'ERR1\\n');writeSync(1,'OUT2\\n');",
            ],
        });
        expect(code).toBe(0);
        const lines = await readTaskJsonl(session, homeDir);

        // All three records present.
        expect(lines.length).toBe(3);
        expect(lines.map((l) => l.text).sort()).toEqual(["ERR1", "OUT1", "OUT2"]);

        // Monotonic seq starting at 1.
        expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);

        // Per-stream order: OUT1 before OUT2 in the stdout subsequence.
        const stdoutTexts = lines.filter((l) => l.out === "stdout").map((l) => l.text);
        expect(stdoutTexts).toEqual(["OUT1", "OUT2"]);

        // Exactly one ERR1, attributed to stderr.
        const stderrTexts = lines.filter((l) => l.out === "stderr").map((l) => l.text);
        expect(stderrTexts).toEqual(["ERR1"]);
    }, 30_000);

    it("the end line of a run shows the same duration `get` shows, not 0s", async () => {
        // The test's pipes are neither a terminal, so `run` takes the detached-worker path, whose end
        // line used to be printed with a fixed 0 ms. `sleep 0.6` rounds to at least 1s, never 0s.
        const homeDir = mkdtempSync(join(tmpdir(), "task-int-"));
        dirs.push(homeDir);
        const session = `test-duration-${Date.now()}`;

        const run = await runTaskCli(["run", "--session", session, "--no-tty", "--", "bash", "-c", "sleep 0.6"], {
            homeDir,
        });
        const get = await runTaskCli(["get", "--session", session], { homeDir });

        expect(run.exitCode).toBe(0);

        const endedDuration = run.stderr.match(/Session \S+ ended \(code 0, ([^)]+)\)/)?.[1];
        const getDuration = get.stderr.match(/exited \(code 0, ([^)]+)\)/)?.[1];

        expect(endedDuration).toBeDefined();
        expect(endedDuration).not.toBe("0s");
        expect(endedDuration).toBe(getDuration);
    }, 30_000);
});
