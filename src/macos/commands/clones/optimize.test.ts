import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("optimize --apply non-TTY guard", () => {
    it("non-TTY --apply without --yes errors with the exact suggestCommand and exits 1", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-applyguard-"));
        try {
            const errs: string[] = [];
            const origErr = console.error;
            const origExit = process.exit;
            let code: number | undefined;
            console.error = (...x: unknown[]) => errs.push(x.join(" "));
            process.exit = ((c?: number) => {
                code = c;
                throw new Error("__exit__");
            }) as typeof process.exit;
            try {
                await createOptimizeCommand().parseAsync(["node", "optimize", dir, "--apply"], { from: "node" });
            } catch (e) {
                if (!(e instanceof Error) || e.message !== "__exit__") {
                    throw e;
                }
            } finally {
                console.error = origErr;
                process.exit = origExit;
            }

            expect(code).toBe(1);
            expect(errs.join("\n")).toContain("--yes");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
