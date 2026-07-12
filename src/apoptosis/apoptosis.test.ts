import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { loadCoverageSet } from "./lib/coverage";
import { churnCountForFile } from "./lib/git";
import { buildInboundImportCounts } from "./lib/imports";
import { evaluateLifecycle } from "./lib/lifecycle";
import { renderJson, renderKillScript, renderPrBody } from "./lib/render";
import { runScan } from "./lib/scan";
import { ApoptosisStateStore } from "./lib/state";
import { scoreSurvival } from "./lib/survival";
import { loadAliasConfig } from "./lib/tsconfig";
import type { AliasConfig, ScanReport } from "./lib/types";
import { listSourceFiles } from "./lib/walk";

function makeTmpDir(prefix: string): string {
    // realpath so file keys agree with git's --show-toplevel (which resolves
    // /var → /private/var on macOS); otherwise churn lookups silently return 0.
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
    const dir = makeTmpDir("apop-git-");
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t.dev");
    git(dir, "config", "user.name", "Test");
    return dir;
}

/** Commit staged changes with an explicit author+committer date so churn
 *  windows are deterministic. */
function commitAt(cwd: string, date: string): void {
    execFileSync("git", ["commit", "-qm", "c"], {
        cwd,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
}

describe("scoreSurvival", () => {
    it("flags a candidate only when all three signals are dead", () => {
        const r = scoreSurvival({ churnCount: 0, inboundImports: 0, hasCoverage: false });
        expect(r.isCandidate).toBe(true);
    });

    it("is rescued by any single surviving signal", () => {
        expect(scoreSurvival({ churnCount: 1, inboundImports: 0, hasCoverage: false }).isCandidate).toBe(false);
        expect(scoreSurvival({ churnCount: 0, inboundImports: 1, hasCoverage: false }).isCandidate).toBe(false);
        expect(scoreSurvival({ churnCount: 0, inboundImports: 0, hasCoverage: true }).isCandidate).toBe(false);
    });

    it("passes the raw signals through unchanged", () => {
        const r = scoreSurvival({ churnCount: 3, inboundImports: 2, hasCoverage: true });
        expect(r).toEqual({ churnCount: 3, inboundImports: 2, hasCoverage: true, isCandidate: false });
    });
});

describe("evaluateLifecycle", () => {
    const graceMs = 14 * 24 * 60 * 60 * 1000;
    const now = Date.parse("2026-06-02T00:00:00.000Z");

    it("alive when not a candidate and never marked", () => {
        expect(evaluateLifecycle({ isCandidate: false, firstMarked: null, now, graceMs })).toBe("alive");
    });

    it("rescued when not a candidate but previously marked", () => {
        const old = new Date(now - 5 * 86400000).toISOString();
        expect(evaluateLifecycle({ isCandidate: false, firstMarked: old, now, graceMs })).toBe("rescued");
    });

    it("dying when candidate with no prior mark", () => {
        expect(evaluateLifecycle({ isCandidate: true, firstMarked: null, now, graceMs })).toBe("dying");
    });

    it("dying when candidate inside the grace window", () => {
        const marked = new Date(now - 5 * 86400000).toISOString();
        expect(evaluateLifecycle({ isCandidate: true, firstMarked: marked, now, graceMs })).toBe("dying");
    });

    it("dead once grace has elapsed", () => {
        const marked = new Date(now - 15 * 86400000).toISOString();
        expect(evaluateLifecycle({ isCandidate: true, firstMarked: marked, now, graceMs })).toBe("dead");
    });

    it("dead exactly at the grace boundary (>=)", () => {
        const marked = new Date(now - graceMs).toISOString();
        expect(evaluateLifecycle({ isCandidate: true, firstMarked: marked, now, graceMs })).toBe("dead");
    });
});

describe("listSourceFiles", () => {
    let dir: string;
    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("lists only matching extensions and skips ignored dirs", () => {
        dir = makeTmpDir("apop-walk-");
        mkdirSync(join(dir, "src"));
        mkdirSync(join(dir, "node_modules"));
        writeFileSync(join(dir, "src", "a.ts"), "");
        writeFileSync(join(dir, "src", "b.tsx"), "");
        writeFileSync(join(dir, "src", "readme.md"), "");
        writeFileSync(join(dir, "node_modules", "c.ts"), "");

        const files = listSourceFiles(dir, ["ts", "tsx"], ["node_modules"]);
        const rel = files.map((f) => f.slice(dir.length + 1)).sort();
        expect(rel).toEqual([join("src", "a.ts"), join("src", "b.tsx")].sort());
    });
});

describe("buildInboundImportCounts", () => {
    let dir: string;
    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("counts inbound imports across relative specifiers and index resolution", () => {
        dir = makeTmpDir("apop-imports-");
        mkdirSync(join(dir, "util"));
        writeFileSync(join(dir, "util", "index.ts"), "export const helper = 1;");
        writeFileSync(join(dir, "used.ts"), "export const x = 2;");
        writeFileSync(join(dir, "orphan.ts"), "export const z = 3;");
        writeFileSync(
            join(dir, "main.ts"),
            `import { helper } from "./util";\nimport { x } from "./used.ts";\nconst y = require("./used");\n`
        );

        const files = [
            join(dir, "util", "index.ts"),
            join(dir, "used.ts"),
            join(dir, "orphan.ts"),
            join(dir, "main.ts"),
        ];
        const counts = buildInboundImportCounts(files);

        expect(counts.get(join(dir, "util", "index.ts"))).toBe(1);
        expect(counts.get(join(dir, "used.ts"))).toBe(1);
        expect(counts.get(join(dir, "orphan.ts"))).toBe(0);
        expect(counts.get(join(dir, "main.ts"))).toBe(0);
    });

    it("resolves tsconfig alias imports (@app/*, exact @ui, dynamic import, .js→.ts)", () => {
        dir = makeTmpDir("apop-alias-");
        mkdirSync(join(dir, "src", "utils", "ui"), { recursive: true });
        writeFileSync(join(dir, "src", "target.ts"), "export const t = 1;");
        writeFileSync(join(dir, "src", "utils", "ui", "index.ts"), "export const ui = 1;");
        writeFileSync(join(dir, "src", "dyn.ts"), "export const d = 1;");
        writeFileSync(join(dir, "src", "barrel.ts"), "export const b = 1;");
        writeFileSync(
            join(dir, "src", "main.ts"),
            [
                `import { t } from "@app/target";`,
                `import { ui } from "@ui";`,
                `const d = await import("@app/dyn");`,
                `import { b } from "@app/barrel.js";`,
            ].join("\n")
        );

        const files = [
            join(dir, "src", "target.ts"),
            join(dir, "src", "utils", "ui", "index.ts"),
            join(dir, "src", "dyn.ts"),
            join(dir, "src", "barrel.ts"),
            join(dir, "src", "main.ts"),
        ];
        const alias: AliasConfig = {
            baseDir: dir,
            paths: { "@app/*": ["./src/*"], "@ui": ["./src/utils/ui/index.ts"] },
        };
        const counts = buildInboundImportCounts(files, alias);

        expect(counts.get(join(dir, "src", "target.ts"))).toBe(1);
        expect(counts.get(join(dir, "src", "utils", "ui", "index.ts"))).toBe(1);
        expect(counts.get(join(dir, "src", "dyn.ts"))).toBe(1);
        expect(counts.get(join(dir, "src", "barrel.ts"))).toBe(1);

        // Without the alias config those same imports resolve to nothing.
        const noAlias = buildInboundImportCounts(files);
        expect(noAlias.get(join(dir, "src", "target.ts"))).toBe(0);
        expect(noAlias.get(join(dir, "src", "dyn.ts"))).toBe(0);
    });

    it('counts bare side-effect imports (import "./foo")', () => {
        dir = makeTmpDir("apop-sideeffect-");
        writeFileSync(join(dir, "handler.ts"), "export const register = () => {};");
        writeFileSync(join(dir, "barrel.ts"), `import "./handler";\nimport "./handler.ts";\n`);

        const files = [join(dir, "handler.ts"), join(dir, "barrel.ts")];
        const counts = buildInboundImportCounts(files);

        // Two side-effect imports from the same file -> one distinct inbound edge.
        expect(counts.get(join(dir, "handler.ts"))).toBe(1);
        expect(counts.get(join(dir, "barrel.ts"))).toBe(0);
    });

    it("prefers the most specific alias (longest prefix wins)", () => {
        dir = makeTmpDir("apop-alias2-");
        mkdirSync(join(dir, "src", "youtube", "ui"), { recursive: true });
        mkdirSync(join(dir, "src", "yt"), { recursive: true });
        writeFileSync(join(dir, "src", "youtube", "ui", "panel.ts"), "export const p = 1;");
        writeFileSync(join(dir, "src", "yt", "panel.ts"), "export const p = 2;");
        writeFileSync(join(dir, "src", "main.ts"), `import { p } from "@app/yt/panel";`);

        const files = [
            join(dir, "src", "youtube", "ui", "panel.ts"),
            join(dir, "src", "yt", "panel.ts"),
            join(dir, "src", "main.ts"),
        ];
        const alias: AliasConfig = {
            baseDir: dir,
            paths: { "@app/*": ["./src/*"], "@app/yt/*": ["./src/youtube/ui/*"] },
        };
        const counts = buildInboundImportCounts(files, alias);

        expect(counts.get(join(dir, "src", "youtube", "ui", "panel.ts"))).toBe(1);
        expect(counts.get(join(dir, "src", "yt", "panel.ts"))).toBe(0);
    });
});

describe("loadAliasConfig", () => {
    let dir: string;
    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reads paths and walks up to the nearest tsconfig", () => {
        dir = makeTmpDir("apop-tsc-");
        writeFileSync(
            join(dir, "tsconfig.json"),
            SafeJSON.stringify({ compilerOptions: { paths: { "@app/*": ["./src/*"] } } })
        );
        mkdirSync(join(dir, "src", "deep"), { recursive: true });

        const cfg = loadAliasConfig(join(dir, "src", "deep"));
        expect(cfg).not.toBeNull();
        expect(cfg?.baseDir).toBe(dir);
        expect(cfg?.paths["@app/*"]).toEqual(["./src/*"]);
    });

    it("returns null when the nearest tsconfig declares no paths", () => {
        dir = makeTmpDir("apop-tsc-none-");
        writeFileSync(join(dir, "tsconfig.json"), SafeJSON.stringify({ compilerOptions: {} }));
        expect(loadAliasConfig(dir)).toBeNull();
    });
});

describe("churnCountForFile", () => {
    let dir: string;
    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("counts commits that touched a file within the window", async () => {
        dir = initRepo();
        writeFileSync(join(dir, "alive.ts"), "1");
        git(dir, "add", ".");
        git(dir, "commit", "-qm", "c1");
        writeFileSync(join(dir, "alive.ts"), "2");
        git(dir, "add", ".");
        git(dir, "commit", "-qm", "c2");

        const alive = await churnCountForFile(join(dir, "alive.ts"), 365, dir);
        expect(alive).toBe(2);
    });

    it("returns 0 for an untracked file", async () => {
        dir = initRepo();
        writeFileSync(join(dir, "alive.ts"), "1");
        git(dir, "add", ".");
        git(dir, "commit", "-qm", "c1");
        writeFileSync(join(dir, "untracked.ts"), "x");

        const untracked = await churnCountForFile(join(dir, "untracked.ts"), 365, dir);
        expect(untracked).toBe(0);
    });
});

describe("loadCoverageSet", () => {
    let dir: string;
    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns covered absolute paths from a json coverage map", () => {
        dir = makeTmpDir("apop-cov-");
        const covPath = join(dir, "coverage.json");
        const covered = join(dir, "src", "covered.ts");
        const uncovered = join(dir, "src", "uncovered.ts");
        writeFileSync(
            covPath,
            SafeJSON.stringify({
                [covered]: { lines: { total: 10, covered: 7 } },
                [uncovered]: { lines: { total: 5, covered: 0 } },
            })
        );

        const set = loadCoverageSet(covPath);
        expect(set.has(covered)).toBe(true);
        expect(set.has(uncovered)).toBe(false);
    });

    it("returns an empty set when no path given", () => {
        expect(loadCoverageSet(undefined).size).toBe(0);
    });
});

describe("ApoptosisStateStore", () => {
    let home: string;
    let prevHome: string | undefined;
    beforeEach(() => {
        home = makeTmpDir("apop-home-");
        prevHome = process.env.GENESIS_TOOLS_HOME;
        process.env.GENESIS_TOOLS_HOME = home;
    });
    afterEach(() => {
        if (prevHome === undefined) {
            delete process.env.GENESIS_TOOLS_HOME;
        } else {
            process.env.GENESIS_TOOLS_HOME = prevHome;
        }

        rmSync(home, { recursive: true, force: true });
    });

    it("marks, reads, and clears per-dir", async () => {
        const store = new ApoptosisStateStore();
        const dir = "/repo";
        const file = "/repo/dead.ts";

        await store.mark(dir, file, "2026-05-01T00:00:00.000Z");
        let marks = await store.getMarks(dir);
        expect(marks[file]).toEqual({ firstMarked: "2026-05-01T00:00:00.000Z" });

        await store.clear(dir, file);
        marks = await store.getMarks(dir);
        expect(marks[file]).toBeUndefined();
    });
});

describe("runScan (e2e)", () => {
    let dir: string;
    let home: string;
    let prevHome: string | undefined;
    beforeEach(() => {
        home = makeTmpDir("apop-home-");
        prevHome = process.env.GENESIS_TOOLS_HOME;
        process.env.GENESIS_TOOLS_HOME = home;
    });
    afterEach(() => {
        if (prevHome === undefined) {
            delete process.env.GENESIS_TOOLS_HOME;
        } else {
            process.env.GENESIS_TOOLS_HOME = prevHome;
        }

        rmSync(home, { recursive: true, force: true });
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("marks an orphan dying on first run and reports churned/imported files alive", async () => {
        dir = initRepo();
        writeFileSync(join(dir, "orphan.ts"), "export const z = 1;");
        git(dir, "add", "orphan.ts");
        commitAt(dir, "2000-01-01T12:00:00");

        writeFileSync(join(dir, "used.ts"), "export const x = 1;");
        writeFileSync(join(dir, "main.ts"), `import { x } from "./used";\nexport const y = x;\n`);
        git(dir, "add", "used.ts", "main.ts");
        commitAt(dir, "2026-05-30T12:00:00");

        const now = Date.parse("2026-06-02T00:00:00.000Z");
        const report = await runScan({
            dir,
            churnDays: 90,
            graceDays: 14,
            exts: ["ts"],
            ignore: ["node_modules", ".git"],
            coveragePath: undefined,
            useState: true,
            now,
        });

        const byPath = new Map(report.files.map((f) => [f.path, f]));
        expect(byPath.get(join(dir, "orphan.ts"))?.status).toBe("dying");
        expect(byPath.get(join(dir, "used.ts"))?.status).toBe("alive");
        expect(byPath.get(join(dir, "main.ts"))?.status).toBe("alive");
        expect(report.counts.candidates).toBe(1);
    });

    it("keeps a file alive when it is only imported via a tsconfig path alias", async () => {
        dir = initRepo();
        writeFileSync(
            join(dir, "tsconfig.json"),
            SafeJSON.stringify({ compilerOptions: { paths: { "@app/*": ["./*"] } } })
        );
        writeFileSync(join(dir, "helper.ts"), "export const h = 1;");
        git(dir, "add", "tsconfig.json", "helper.ts");
        commitAt(dir, "2000-01-01T12:00:00");

        writeFileSync(join(dir, "main.ts"), `import { h } from "@app/helper";\nexport const y = h;\n`);
        git(dir, "add", "main.ts");
        commitAt(dir, "2026-05-30T12:00:00");

        const report = await runScan({
            dir,
            churnDays: 90,
            graceDays: 14,
            exts: ["ts"],
            ignore: ["node_modules", ".git"],
            coveragePath: undefined,
            useState: true,
            now: Date.parse("2026-06-02T00:00:00.000Z"),
        });

        const byPath = new Map(report.files.map((f) => [f.path, f]));
        // helper.ts has no recent churn and no *relative* importer; only the alias
        // import in main.ts keeps it alive. Without alias resolution it would be dying.
        expect(byPath.get(join(dir, "helper.ts"))?.status).toBe("alive");
        expect(byPath.get(join(dir, "helper.ts"))?.survival.inboundImports).toBe(1);
    });

    it("graduates a long-marked orphan to dead, then rescues it when imported", async () => {
        dir = initRepo();
        writeFileSync(join(dir, "orphan.ts"), "export const z = 1;");
        git(dir, "add", "orphan.ts");
        commitAt(dir, "2000-01-01T12:00:00");

        const orphan = join(dir, "orphan.ts");
        const opts = {
            dir,
            churnDays: 90,
            graceDays: 14,
            exts: ["ts"],
            ignore: ["node_modules", ".git"],
            coveragePath: undefined,
            useState: true,
        };

        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const firstReport = await runScan({ ...opts, now: t0 });
        expect(firstReport.files.find((f) => f.path === orphan)?.status).toBe("dying");

        const t1 = t0 + 20 * 86400000;
        const deadReport = await runScan({ ...opts, now: t1 });
        expect(deadReport.files.find((f) => f.path === orphan)?.status).toBe("dead");
        expect(deadReport.counts.ready).toBe(1);

        writeFileSync(join(dir, "main.ts"), `import { z } from "./orphan";\nexport const y = z;\n`);
        const t2 = t1 + 1 * 86400000;
        const rescuedReport = await runScan({ ...opts, now: t2 });
        expect(rescuedReport.files.find((f) => f.path === orphan)?.status).toBe("rescued");
        expect(rescuedReport.counts.rescued).toBe(1);

        const store = new ApoptosisStateStore();
        const marks = await store.getMarks(dir);
        expect(marks[orphan]).toBeUndefined();
    });

    it("--no-state writes nothing under GENESIS_TOOLS_HOME", async () => {
        dir = initRepo();
        writeFileSync(join(dir, "orphan.ts"), "export const z = 1;");
        git(dir, "add", "orphan.ts");
        commitAt(dir, "2000-01-01T12:00:00");

        await runScan({
            dir,
            churnDays: 90,
            graceDays: 14,
            exts: ["ts"],
            ignore: ["node_modules", ".git"],
            coveragePath: undefined,
            useState: false,
            now: Date.parse("2026-06-02T00:00:00.000Z"),
        });

        expect(existsSync(join(home, ".genesis-tools", "apoptosis", "cache", "state.json"))).toBe(false);
    });
});

function fakeReport(): ScanReport {
    return {
        dir: "/repo",
        scannedAt: "2026-06-02T00:00:00.000Z",
        churnDays: 90,
        graceDays: 14,
        counts: { scanned: 2, candidates: 1, rescued: 0, ready: 1 },
        files: [
            {
                path: "/repo/dead.ts",
                survival: { churnCount: 0, inboundImports: 0, hasCoverage: false, isCandidate: true },
                status: "dead",
                firstMarked: "2026-05-01T00:00:00.000Z",
                daysMarked: 32,
                daysLeft: 0,
            },
            {
                path: "/repo/alive.ts",
                survival: { churnCount: 3, inboundImports: 1, hasCoverage: false, isCandidate: false },
                status: "alive",
                firstMarked: null,
                daysMarked: null,
                daysLeft: null,
            },
        ],
    };
}

describe("renderers", () => {
    it("renderJson round-trips through SafeJSON", () => {
        const parsed = SafeJSON.parse(renderJson(fakeReport())) as ScanReport;
        expect(parsed.counts.ready).toBe(1);
        expect(parsed.files[0].path).toBe("/repo/dead.ts");
    });

    it("renderKillScript lists only ready-to-die files", () => {
        const script = renderKillScript(fakeReport());
        expect(script).toContain("#!/usr/bin/env bash");
        expect(script).toContain("/repo/dead.ts");
        expect(script).not.toContain("/repo/alive.ts");
    });

    it("renderPrBody lists ready-to-die files as a checklist", () => {
        const body = renderPrBody(fakeReport());
        expect(body).toContain("- [ ] `/repo/dead.ts`");
        expect(body).not.toContain("alive.ts");
    });
});

describe("CLI --json (e2e)", () => {
    let dir: string;
    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("emits parseable JSON to stdout with --json --no-state", async () => {
        dir = initRepo();
        writeFileSync(join(dir, "orphan.ts"), "export const z = 1;");
        git(dir, "add", "orphan.ts");
        commitAt(dir, "2000-01-01T12:00:00");

        const entry = join(import.meta.dir, "index.ts");
        const proc = Bun.spawn({
            cmd: ["bun", entry, dir, "--json", "--no-state", "--ext", "ts"],
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        const parsed = SafeJSON.parse(stdout) as ScanReport;
        expect(typeof parsed).toBe("object");
        expect(parsed.counts).toBeDefined();
        expect(parsed.counts.scanned).toBeGreaterThanOrEqual(1);
    });
});
