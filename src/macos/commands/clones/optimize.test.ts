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

import { appendOp, newProcessId, readProcess, writeMeta } from "@app/macos/lib/clones/audit";
import { JsonRenderer } from "@app/macos/lib/clones/render/json";

describe("optimize --list", () => {
    it("--list --format json lists recorded processes newest-first", async () => {
        const id = newProcessId();
        writeMeta({
            id,
            state: "dry-run",
            roots: ["/tmp/list-test"],
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            planCacheHit: false,
        });
        const logs: string[] = [];
        const orig = console.log;
        console.log = (...x: unknown[]) => logs.push(x.join(" "));
        try {
            await createOptimizeCommand().parseAsync(["node", "optimize", "--list", "--format", "json"], {
                from: "node",
            });
        } finally {
            console.log = orig;
        }

        const parsed = SafeJSON.parse(logs.join("\n")) as { processes: { id: string }[] };
        expect(parsed.processes.some((pr) => pr.id === id)).toBe(true);
    });
});

describe("optimize --log", () => {
    it("--log json === JsonRenderer.processReport of the replayed process (apply-tail parity)", async () => {
        const id = newProcessId();
        const started = new Date().toISOString();
        writeMeta({
            id,
            state: "applied",
            roots: ["/tmp/log-test"],
            startedAt: started,
            endedAt: started,
            planCacheHit: false,
        });
        appendOp(id, {
            seq: 1,
            ts: started,
            op: "clone",
            status: "ok",
            bytes: 2048,
            keep: "/tmp/log-test/k",
            replace: "/tmp/log-test/r",
            modeBefore: 0o644,
            mtimeBeforeMs: 1,
            sha256Before: "deadbeef",
            sha256After: "deadbeef",
        });

        const logs: string[] = [];
        const orig = console.log;
        console.log = (...x: unknown[]) => logs.push(x.join(" "));
        try {
            await createOptimizeCommand().parseAsync(
                ["node", "optimize", "--log", "--process", id, "--format", "json"],
                { from: "node" },
            );
        } finally {
            console.log = orig;
        }

        const rep = readProcess(id);
        expect(rep).not.toBeNull();
        const expected = new JsonRenderer().processReport(rep!);
        expect(logs.join("\n").trim()).toBe(expected.trim());
    });

    it("unknown --process exits 1 and lists closest ids", async () => {
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
            await createOptimizeCommand().parseAsync(
                ["node", "optimize", "--log", "--process", "definitely-not-real-zzz"],
                { from: "node" },
            );
        } catch (e) {
            if (!(e instanceof Error) || e.message !== "__exit__") {
                throw e;
            }
        } finally {
            console.error = origErr;
            process.exit = origExit;
        }

        expect(code).toBe(1);
        expect(errs.join("\n").toLowerCase()).toContain("process");
    });
});
