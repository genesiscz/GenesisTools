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
    it("preserves stdout/stderr order in jsonl", async () => {
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
        expect(lines.map((l) => l.text)).toEqual(["OUT1", "OUT2", "ERR1"]);
        expect(lines.map((l) => l.out)).toEqual(["stdout", "stdout", "stderr"]);
        expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    }, 30_000);
});
