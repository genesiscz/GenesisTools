import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOptimizeCommand } from "@app/macos/commands/clones/optimize";
import { SafeJSON } from "@genesiscz/utils/json";

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
            let output = "";
            const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
                (
                    chunk: string | Uint8Array,
                    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                    callback?: (error?: Error | null) => void
                ) => {
                    output += String(chunk);
                    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                    cb?.();
                    return true;
                }
            );
            try {
                await createOptimizeCommand().parseAsync(
                    ["node", "optimize", dir, "--format", "json", "--min-real", "1024"],
                    { from: "node" }
                );
            } finally {
                stdoutSpy.mockRestore();
            }

            const rep = SafeJSON.parse(output) as {
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
        let output = "";
        const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
            (
                chunk: string | Uint8Array,
                encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                callback?: (error?: Error | null) => void
            ) => {
                output += String(chunk);
                const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                cb?.();
                return true;
            }
        );
        try {
            await createOptimizeCommand().parseAsync(["node", "optimize", "--list", "--format", "json"], {
                from: "node",
            });
        } finally {
            stdoutSpy.mockRestore();
        }

        const parsed = SafeJSON.parse(output) as { processes: { id: string }[] };
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

        let output = "";
        const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
            (
                chunk: string | Uint8Array,
                encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                callback?: (error?: Error | null) => void
            ) => {
                output += String(chunk);
                const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                cb?.();
                return true;
            }
        );
        try {
            await createOptimizeCommand().parseAsync(
                ["node", "optimize", "--log", "--process", id, "--format", "json"],
                { from: "node" }
            );
        } finally {
            stdoutSpy.mockRestore();
        }

        const rep = readProcess(id);
        expect(rep).not.toBeNull();
        const expected = new JsonRenderer().processReport(rep!);
        expect(output.trim()).toBe(expected.trim());
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
                { from: "node" }
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

describe("optimize --dir", () => {
    it("declares the selector flags", () => {
        const longs = createOptimizeCommand().options.map((o) => o.long);
        for (const f of ["--dir", "--worktrees-of", "--targets"]) {
            expect(longs).toContain(f);
        }
    });

    it("--dir expands to the install trees under it and plans across them", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-optdir-"));
        try {
            for (const name of ["w1", "w2"]) {
                mkdirSync(join(outer, name, "node_modules", "dep"), { recursive: true });
                writeFileSync(join(outer, name, "node_modules", "dep", "index.js"), Buffer.alloc(64_000, 7));
            }

            let output = "";
            const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
                (
                    chunk: string | Uint8Array,
                    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                    callback?: (error?: Error | null) => void
                ) => {
                    output += String(chunk);
                    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                    cb?.();
                    return true;
                }
            );
            try {
                await createOptimizeCommand().parseAsync(
                    [
                        "node",
                        "optimize",
                        "--dir",
                        outer,
                        "--targets",
                        "node_modules",
                        "--format",
                        "json",
                        "--min-real",
                        "1024",
                    ],
                    { from: "node" }
                );
            } finally {
                stdoutSpy.mockRestore();
            }

            const rep = SafeJSON.parse(output) as { roots: string[]; totals: { bytesReclaimed: number } };
            expect(rep.roots.length).toBe(2);
            expect(rep.totals.bytesReclaimed).toBeGreaterThanOrEqual(64_000);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    async function captureFailure(argv: string[]): Promise<{ code: number | undefined; err: string }> {
        const errs: string[] = [];
        const origErr = console.error;
        const origExit = process.exit;
        let code: number | undefined;
        console.error = (...x: unknown[]) => errs.push(x.join(" "));
        process.exit = ((c?: number) => {
            code = c;
            throw new Error("__exit__");
        }) as typeof process.exit;
        process.exitCode = undefined;
        try {
            await createOptimizeCommand().parseAsync(["node", "optimize", ...argv], { from: "node" });
        } catch (e) {
            if (!(e instanceof Error) || e.message !== "__exit__") {
                throw e;
            }
        } finally {
            console.error = origErr;
            process.exit = origExit;
        }

        // A refusal either calls process.exit or sets process.exitCode; the
        // shared enum-flag resolver uses the latter.
        const exitCode = process.exitCode;
        process.exitCode = undefined;
        return { code: code ?? (typeof exitCode === "number" ? exitCode : undefined), err: errs.join("\n") };
    }

    it("an empty --targets in non-TTY prints the possible values and exits 1", async () => {
        const res = await captureFailure(["--dir", tmpdir(), "--targets"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("gitignored");
    });

    it("--dir with --include <target kind> is refused and pointed at --targets", async () => {
        const res = await captureFailure(["--dir", tmpdir(), "--include", "node_modules"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("--targets");
        expect(res.err).toContain("node_modules");
    });
});

describe("optimize selector flags", () => {
    function fixture(): string {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-optsel-"));
        const proj = join(outer, "proj");
        mkdirSync(join(proj, "vendor"), { recursive: true });
        for (const name of ["w1", "w2"]) {
            const dep = join(proj, name, "node_modules", "dep");
            mkdirSync(dep, { recursive: true });
            writeFileSync(join(dep, "index.js"), Buffer.alloc(100_000, 4));
        }

        return outer;
    }

    async function capture(argv: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
        let output = "";
        const errs: string[] = [];
        const origErr = console.error;
        const origExit = process.exit;
        let code: number | undefined;
        process.exitCode = undefined;
        const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
            (
                chunk: string | Uint8Array,
                encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                callback?: (error?: Error | null) => void
            ) => {
                output += String(chunk);
                const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                cb?.();
                return true;
            }
        );
        console.error = (...x: unknown[]) => errs.push(x.join(" "));
        process.exit = ((c?: number) => {
            code = c;
            throw new Error("__exit__");
        }) as typeof process.exit;
        try {
            await createOptimizeCommand().parseAsync(["node", "optimize", ...argv], { from: "node" });
        } catch (e) {
            if (!(e instanceof Error) || e.message !== "__exit__") {
                throw e;
            }
        } finally {
            stdoutSpy.mockRestore();
            console.error = origErr;
            process.exit = origExit;
        }

        const exitCode = process.exitCode;
        process.exitCode = undefined;
        return {
            out: output,
            err: errs.join("\n"),
            code: code ?? (typeof exitCode === "number" ? exitCode : undefined),
        };
    }

    it("--targets without --dir narrows the scan instead of being ignored", async () => {
        const outer = fixture();
        try {
            // `vendor` is empty, so a --targets that is honoured finds no roots.
            const res = await capture([join(outer, "proj"), "--targets", "vendor", "--min-real", "1024"]);
            expect(res.code).toBe(2);
            expect(res.err).toContain("No roots");
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("keeps positional roots when --dir is also given", async () => {
        const outer = fixture();
        try {
            const res = await capture([
                join(outer, "proj"),
                "--dir",
                join(outer, "nowhere-else"),
                "--targets",
                "node_modules",
                "--min-real",
                "1024",
                "--format",
                "json",
            ]);
            const rep = SafeJSON.parse(res.out) as { roots: string[] };
            expect(rep.roots.length).toBe(2);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    }, 30_000);

    it("refuses --node-modules beside the discovery flags instead of lying in the cache key", async () => {
        const outer = fixture();
        try {
            const res = await capture([join(outer, "proj"), "--dir", join(outer, "proj"), "--node-modules"]);
            expect(res.code).toBe(1);
            expect(res.err).toContain("--node-modules");
            expect(res.err).toContain("--targets");
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("--worktrees-of names an unknown repository instead of exiting 0", async () => {
        const outer = fixture();
        try {
            const res = await capture([join(outer, "proj"), "--worktrees-of", "no-such-repo-xyz"]);
            expect(res.code).toBe(1);
            expect(res.err).toContain("no-such-repo-xyz");
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});
