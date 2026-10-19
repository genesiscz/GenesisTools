import { describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCachedPlan } from "@app/macos/lib/clones/cache";
import { getPreset, presetsPath, touchPreset, updatePresetAuto } from "@app/macos/lib/clones/presets";
import { type ClonesConfig, storage } from "@app/macos/lib/clones/store";
import { byKeys, contractShapeMismatches, readKitFixtureJson } from "@app/macos/lib/kit-fixtures";
import { SafeJSON } from "@genesiscz/utils/json";

// A finished plan registers the daemon tasks. Keep the real `tools daemon`
// config out of the test run and record what would have been registered.
const registerSpy = mock(async (opts: { name: string }) => opts.name === "macos-clones-scan");
mock.module("@app/daemon/lib/register", () => ({
    registerTask: registerSpy,
    unregisterTask: mock(async () => true),
    isTaskRegistered: mock(async () => false),
}));
mock.module("@app/daemon/lib/config", () => ({ getTask: mock(async () => undefined) }));

const { createReclaimCommand } = await import("@app/macos/commands/clones/reclaim");

interface Captured {
    out: string;
    err: string;
    code: number | undefined;
}

async function run(argv: string[]): Promise<Captured> {
    let output = "";
    const errLines: string[] = [];
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
    console.error = (...x: unknown[]) => errLines.push(x.join(" "));
    process.exit = ((c?: number) => {
        code = c;
        throw new Error("__exit__");
    }) as typeof process.exit;
    try {
        await createReclaimCommand().parseAsync(["node", "reclaim", ...argv], { from: "node" });
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
    return { out: output.replace(/\n$/, ""), err: errLines.join("\n"), code: code ?? exitCode };
}

function twoTrees(): string {
    const outer = mkdtempSync(join(tmpdir(), "gt-cl-recl-cmd-"));
    for (const name of ["w1", "w2"]) {
        const dep = join(outer, name, "node_modules", "dep");
        mkdirSync(join(dep, "lib"), { recursive: true });
        writeFileSync(join(dep, "index.js"), Buffer.alloc(50_000, 1));
        writeFileSync(join(dep, "lib", "a.js"), Buffer.alloc(40_000, 2));
    }

    return outer;
}

interface PlanJson {
    roots: string[];
    sets: Array<{ copies: number }>;
    totalReclaimable: number;
    fromSnapshot: boolean;
    selector: { minReal: number; exclude: string[]; targets: string[]; keepPartners: string[] };
}

describe("createReclaimCommand", () => {
    it("exposes plan, apply, presets and stores", () => {
        const subs = createReclaimCommand()
            .commands.map((c) => c.name())
            .sort();
        expect(subs).toEqual(["apply", "plan", "presets", "stores"]);
    });

    it("plan --format json reports the discovered roots and the duplicate set, and writes the snapshot", async () => {
        const outer = twoTrees();
        try {
            const res = await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1KB",
                "--format",
                "json",
            ]);
            const plan = SafeJSON.parse(res.out) as PlanJson;
            expect(plan.roots.length).toBe(2);
            expect(plan.sets.length).toBe(1);
            expect(plan.sets[0].copies).toBe(2);
            expect(plan.totalReclaimable).toBeGreaterThan(0);
            expect(plan.fromSnapshot).toBe(false);

            const cached = await getCachedPlan({
                roots: plan.roots,
                minSize: 1024,
                include: [],
                exclude: [],
                nodeModules: false,
                targets: ["node_modules"],
                worktreesOf: "",
                keepPartners: [],
            });
            expect(cached?.plan.length).toBe(1);
            expect(cached?.rootStamps.length).toBe(2);

            // The finished plan registered both daemon tasks (none existed).
            const names = registerSpy.mock.calls.map((c) => c[0].name);
            expect(names).toContain("macos-clones-scan");
            expect(names).toContain("macos-clones-cache-prune");
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("returns JSON envelopes for apply and preset selector errors before execution", async () => {
        const cases = [
            ["apply", "--format", "json"],
            ["apply", "--dir", tmpdir(), "--min-real", "bad", "--format", "json"],
            ["apply", "--dir", tmpdir(), "--targets", "--format", "jsonl"],
            ["apply", "--dir", tmpdir(), "--keep-partners", "unknown-fixture", "--format", "json"],
            ["apply", "--dir", tmpdir(), "--rewrite-stores", "unknown-fixture", "--format", "json"],
            ["presets", "save", "invalid-fixture", "--json"],
        ];
        for (const args of cases) {
            const result = await run(args);
            expect(result.code).toBeGreaterThan(0);
            expect(SafeJSON.parse(result.out, { strict: true })).toMatchObject({
                error: { kind: "invalid-arguments" },
            });
        }
    });

    it("returns a JSON envelope when apply cannot find the requested repository", async () => {
        const root = mkdtempSync(join(tmpdir(), "clones-no-repo-"));
        try {
            const result = await run([
                "apply",
                "--dir",
                root,
                "--worktrees-of",
                "missing-fixture",
                "--format",
                "json",
                "--no-daemon",
            ]);
            expect(result.code).toBe(1);
            expect(SafeJSON.parse(result.out, { strict: true })).toMatchObject({ error: { kind: "repo-not-found" } });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("an empty --targets in non-TTY prints the possible values and exits 1", async () => {
        const res = await run(["plan", "--dir", tmpdir(), "--targets"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("gitignored");
        expect(res.err).toContain("node_modules");
        expect(res.err).toContain("--targets");
    });

    // Checks the FORMAT only (one record, one line). Delivery of a large
    // result through a real pipe is printLn's guarantee, pinned by the
    // subprocess test in src/utils/cli/stdout.test.ts.
    it("--no-daemon skips the daemon registration", async () => {
        const outer = twoTrees();
        try {
            registerSpy.mockClear();
            const res = await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1KB",
                "--no-daemon",
            ]);
            expect(res.code).toBe(0);
            expect(registerSpy.mock.calls.length).toBe(0);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("--format jsonl prints the plan as one line", async () => {
        const outer = twoTrees();
        try {
            const res = await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1KB",
                "--format",
                "jsonl",
            ]);
            expect(res.out).not.toContain("\n");
            expect((SafeJSON.parse(res.out) as PlanJson).sets.length).toBe(1);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("a non-positive --min-real is refused instead of scanning every file", async () => {
        const res = await run(["plan", "--dir", tmpdir(), "--min-real", "-1"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("--min-real");
        expect(res.err).toContain("positive size");
    });

    it("an unknown --keep-partners value is refused with the possible values", async () => {
        const res = await run(["plan", "--dir", tmpdir(), "--keep-partners", "cargo"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("cargo");
        expect(res.err).toContain("bun");
    });

    it("apply without --yes in non-TTY refuses and names the flag", async () => {
        const outer = twoTrees();
        try {
            const res = await run(["apply", "--dir", outer, "--targets", "node_modules", "--min-real", "1KB"]);
            expect(res.code).toBe(1);
            expect(res.err).toContain("--yes");
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("apply reuses the plan snapshot while the roots are unchanged, and rescans after a change", async () => {
        const outer = twoTrees();
        try {
            await run(["plan", "--dir", outer, "--targets", "node_modules", "--min-real", "1KB", "--format", "json"]);
            const reused = await run([
                "apply",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1KB",
                "--format",
                "json",
            ]);
            expect(reused.code).toBe(1);
            expect(reused.err).toContain("--yes");

            // A new top-level entry moves the root's mtime → stale → rescan.
            writeFileSync(join(outer, "w1", "node_modules", "newcomer"), "x");
            const fresh = await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1KB",
                "--format",
                "json",
            ]);
            expect((SafeJSON.parse(fresh.out) as PlanJson).fromSnapshot).toBe(false);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("plan --save stores the selector; presets list, show, save and rm round-trip", async () => {
        const outer = twoTrees();
        try {
            await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1KB",
                "--format",
                "json",
                "--save",
                "fixture",
            ]);
            const listed = await run(["presets", "list", "--format", "json"]);
            const parsed = SafeJSON.parse(listed.out) as { presets: Array<{ id: string; targets: string[] }> };
            expect(parsed.presets.some((x) => x.id === "fixture" && x.targets[0] === "node_modules")).toBe(true);

            const saved = await run(["presets", "save", "second", "--dir", outer, "--targets", "vendor"]);
            expect(saved.out).toContain("second");
            const shown = await run(["presets", "show", "second"]);
            expect((SafeJSON.parse(shown.out) as { targets: string[] }).targets).toEqual(["vendor"]);

            expect((await run(["presets", "rm", "fixture"])).out).toContain("fixture");
            expect((await run(["presets", "rm", "second"])).out).toContain("second");
            expect((await run(["presets", "rm", "second"])).code).toBe(1);
        } finally {
            if (existsSync(presetsPath())) {
                rmSync(presetsPath());
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("a persisted daemon opt-out survives the next plan", async () => {
        const outer = twoTrees();
        const snapshot = await storage.getConfig<ClonesConfig>();
        try {
            await storage.setConfig({ ...(snapshot ?? { watchedDirs: [] }), daemon: false });
            registerSpy.mockClear();
            const res = await run(["plan", "--dir", outer, "--targets", "node_modules", "--min-real", "1KB"]);
            expect(res.code).toBe(0);
            expect(registerSpy.mock.calls.length).toBe(0);

            // Lifting the opt-out lets a plan register again.
            await storage.setConfig({ ...(snapshot ?? { watchedDirs: [] }), daemon: true });
            const again = await run(["plan", "--dir", outer, "--targets", "node_modules", "--min-real", "1KB"]);
            expect(again.code).toBe(0);
            expect(registerSpy.mock.calls.length).toBeGreaterThan(0);
        } finally {
            if (snapshot === null) {
                await storage.clearConfig();
            } else {
                await storage.setConfig(snapshot);
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("presets run --apply does not record a run that was refused for a missing --yes", async () => {
        const outer = twoTrees();
        try {
            await run(["presets", "save", "refused", "--dir", outer, "--targets", "node_modules", "--min-real", "1KB"]);
            const res = await run(["presets", "run", "refused", "--apply"]);
            expect(res.code).toBe(1);
            expect(getPreset("refused")?.lastRunAt).toBeUndefined();
            expect(getPreset("refused")?.lastReclaimable).toBeUndefined();
        } finally {
            if (existsSync(presetsPath())) {
                rmSync(presetsPath());
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("presets auto --on arms a plan with limits, the table shows it, and --off stops it", async () => {
        const outer = twoTrees();
        try {
            await run(["presets", "save", "nightly", "--dir", outer, "--targets", "node_modules", "--min-real", "1KB"]);
            const armed = await run(["presets", "auto", "nightly", "--on", "--max-bytes", "2GB", "--max-files", "40"]);
            expect(armed.code ?? 0).toBe(0);
            expect(getPreset("nightly")?.auto).toEqual({ enabled: true, maxBytes: 2 * 1024 ** 3, maxFiles: 40 });

            const listed = await run(["presets", "list", "--format", "table"]);
            expect(listed.out).toContain("AUTO");
            expect(listed.out).toContain("on, dry run next");

            await run(["presets", "auto", "nightly", "--off"]);
            expect(getPreset("nightly")?.auto?.enabled).toBe(false);

            const bad = await run(["presets", "auto", "nightly", "--max-bytes", "lots"]);
            expect(bad.code).toBe(1);
            const unknown = await run(["presets", "auto", "missing", "--on"]);
            expect(unknown.code).toBe(1);
        } finally {
            if (existsSync(presetsPath())) {
                rmSync(presetsPath());
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("arming has no default limits, none clears one, and saving over the id keeps auto and the last run", async () => {
        const outer = twoTrees();
        const save = (targets: string) =>
            run(["presets", "save", "kept", "--dir", outer, "--targets", targets, "--min-real", "1KB"]);
        try {
            await save("node_modules");
            await run(["presets", "auto", "kept", "--on"]);
            expect(getPreset("kept")?.auto).toEqual({ enabled: true });

            await run(["presets", "auto", "kept", "--max-bytes", "2GB", "--max-files", "40"]);
            await run(["presets", "auto", "kept", "--max-bytes", "none"]);
            expect(getPreset("kept")?.auto).toEqual({ enabled: true, maxFiles: 40 });

            const created = getPreset("kept")?.createdAt;
            updatePresetAuto("kept", { enabled: true, maxFiles: 40, dryRunAt: "2026-10-19T03:00:00.000Z" });
            touchPreset("kept", { lastRunAt: "2026-10-19T03:00:00.000Z", lastReclaimable: 4096 });

            await save("node_modules");
            const same = getPreset("kept");
            expect(same?.auto).toEqual({ enabled: true, maxFiles: 40, dryRunAt: "2026-10-19T03:00:00.000Z" });
            expect(same?.createdAt).toBe(created);
            expect(same?.lastReclaimable).toBe(4096);

            await save("vendor");
            // A new selector keeps auto armed, but its next run is a dry run again.
            expect(getPreset("kept")?.auto).toEqual({ enabled: true, maxFiles: 40 });
            expect(getPreset("kept")?.targets).toEqual(["vendor"]);
        } finally {
            if (existsSync(presetsPath())) {
                rmSync(presetsPath());
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("presets list --format table prints an aligned inventory", async () => {
        const outer = twoTrees();
        try {
            await run(["presets", "save", "boxed", "--dir", outer, "--targets", "node_modules", "--min-real", "1KB"]);
            const listed = await run(["presets", "list", "--format", "table"]);
            expect(listed.out).toContain("ID");
            expect(listed.out).toContain("TARGETS");
            expect(listed.out).toContain("boxed");
            expect(listed.out).toContain("─");
        } finally {
            if (existsSync(presetsPath())) {
                rmSync(presetsPath());
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });
});

describe("reclaim JSON contracts", () => {
    it("apply without --yes prints a confirm-required envelope on stdout as well as the stderr hint", async () => {
        const outer = twoTrees();
        try {
            const res = await run([
                "apply",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1KB",
                "--no-daemon",
                "--format",
                "json",
            ]);
            const envelope = SafeJSON.parse(res.out) as { error: { kind: string; command: string; sets: number } };

            expect(res.code).toBe(1);
            expect(res.err).toContain("--yes");
            expect(envelope.error).toMatchObject({ kind: "confirm-required", command: "reclaim apply", sets: 1 });
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== "darwin")(
        "apply --yes --format json carries the plan totals beside the measured report",
        async () => {
            const outer = twoTrees();
            try {
                const res = await run([
                    "apply",
                    "--dir",
                    outer,
                    "--targets",
                    "node_modules",
                    "--min-real",
                    "1KB",
                    "--no-daemon",
                    "--yes",
                    "--format",
                    "json",
                ]);
                const report = SafeJSON.parse(res.out) as Record<string, unknown> & {
                    state: string;
                    plan: { runId: string; sets: number; totalFreeable: number; totalFreeableUpTo: number };
                };

                expect(res.code).toBe(0);
                expect(report.state).toBe("applied");
                expect(report.plan.sets).toBe(1);
                expect(typeof report.plan.runId).toBe("string");
                expect(report.plan.totalFreeableUpTo).toBeGreaterThanOrEqual(report.plan.totalFreeable);
                // An op's keys depend on what it did (a clone records its hashes after, a skip does not), and the
                // plan cache's age exists only on a hit.
                expect(
                    contractShapeMismatches(report, readKitFixtureJson("contract-clones-apply-result.json"), {
                        kinds: { "$.ops[]": byKeys("op", "status") },
                        optionalKeys: { "$.planCache": ["ageMs"] },
                    })
                ).toEqual([]);
            } finally {
                rmSync(outer, { recursive: true, force: true });
            }
        }
    );

    it("presets save and rm print JSON with --json, and an unknown preset prints an envelope", async () => {
        const outer = twoTrees();
        try {
            const saved = await run(["presets", "save", "json-one", "--dir", outer, "--targets", "vendor", "--json"]);
            expect((SafeJSON.parse(saved.out) as { preset: { id: string } }).preset.id).toBe("json-one");

            const removed = await run(["presets", "rm", "json-one", "--json"]);
            expect(SafeJSON.parse(removed.out)).toEqual({ removed: "json-one" });

            const missing = await run(["presets", "rm", "json-one", "--json"]);
            expect(missing.code).toBe(1);
            expect((SafeJSON.parse(missing.out) as { error: { kind: string } }).error.kind).toBe("unknown-preset");
        } finally {
            if (existsSync(presetsPath())) {
                rmSync(presetsPath());
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });
});
