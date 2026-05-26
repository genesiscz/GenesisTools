import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskJsonl, runTaskCapture } from "@app/task/lib/test-harness";

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
});
