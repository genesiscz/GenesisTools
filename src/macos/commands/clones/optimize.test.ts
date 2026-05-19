import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createOptimizeCommand } from "@app/macos/commands/clones/optimize";
import { SafeJSON } from "@app/utils/json";

describe("createOptimizeCommand (dry-run default)", () => {
    it("declares apply/rollback/list/log/process/no-cache/yes flags", () => {
        const longs = createOptimizeCommand().options.map((o) => o.long);
        for (const f of ["--apply", "--rollback", "--list", "--log", "--process", "--no-cache", "--yes", "--format"]) {
            expect(longs).toContain(f);
        }
    });

    it("no --apply → dry-run ProcessReport (state dry-run, 0 ops), mutates nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-optdry-"));
        try {
            mkdirSync(join(dir, "a"), { recursive: true });
            mkdirSync(join(dir, "b"), { recursive: true });
            const payload = Buffer.alloc(64_000, 7);
            writeFileSync(join(dir, "a", "f"), payload);
            writeFileSync(join(dir, "b", "f"), payload);
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...x: unknown[]) => logs.push(x.join(" "));
            try {
                await createOptimizeCommand().parseAsync(["node", "optimize", dir, "--format", "json"], {
                    from: "node",
                });
            } finally {
                console.log = orig;
            }

            const rep = SafeJSON.parse(logs.join("\n")) as {
                state: string;
                ops: unknown[];
                totals: { bytesReclaimed: number };
            };
            expect(rep.state).toBe("dry-run");
            expect(rep.ops).toEqual([]);
            expect(rep.totals.bytesReclaimed).toBeGreaterThanOrEqual(64_000);
            expect(readdirSync(join(dir, "b")).length).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
