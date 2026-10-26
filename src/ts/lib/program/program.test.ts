import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeRecursive, waitForPath } from "@genesiscz/utils/fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import {
    costByFolder,
    duplicatePackages,
    folderClosures,
    folderOf,
    packageOf,
    packageSizes,
    whyChain,
} from "./closure";
import { generateTrace, runProgramWorker } from "./run";
import { groupSites, sitesForKey, sortGroups } from "./sites";
import { analyzeTrace } from "./trace";
import type { GraphFile, GraphResult, SiteCost } from "./types";

function graphOf(files: Array<Partial<GraphFile> & { path: string }>): GraphResult {
    return {
        mode: "graph",
        typescript: "6.0.0",
        runtime: "node",
        config: "/p/tsconfig.json",
        gcForced: true,
        files: files.map((file) => ({ bytes: 10, root: false, base: false, declaration: false, imports: [], ...file })),
    };
}

describe("program closure", () => {
    const graph = graphOf([
        { path: "node_modules/typescript/lib/lib.es5.d.ts", base: true, declaration: true, bytes: 100 },
        { path: "src/hub/a.ts", root: true, imports: [2, 4] },
        { path: "src/utils/u.ts", root: true, imports: [3] },
        { path: "node_modules/@scope/pkg/index.d.ts", declaration: true, bytes: 1000, imports: [5] },
        { path: "node_modules/big/index.d.ts", declaration: true, bytes: 5000 },
        { path: "node_modules/@scope/pkg/node_modules/inner/x.d.ts", declaration: true, bytes: 7 },
        { path: "src/ambient.d.ts", root: true, declaration: true, bytes: 3 },
        { path: "src/youtube/y.ts", root: true },
    ]);

    it("names folders and packages, the innermost node_modules winning", () => {
        expect(folderOf("src/hub/lib/x.ts")).toBe("src/hub");
        expect(folderOf("scripts/ci/x.ts")).toBe("scripts");
        expect(folderOf("test-a.ts")).toBe("(top-level files)");
        expect(folderOf("node_modules/a/b.d.ts")).toBeNull();
        expect(packageOf("node_modules/@scope/pkg/node_modules/inner/x.d.ts")).toBe("inner");
        expect(packageOf("node_modules/@scope/pkg/index.d.ts")).toBe("@scope/pkg");
        expect(packageOf("src/a.ts")).toBeNull();
    });

    it("holds what one folder reaches, plus the base and the ambient root declarations", () => {
        const hub = folderClosures(graph).find((row) => row.folder === "src/hub");
        // a.ts, u.ts, pkg, big, inner, lib.es5, ambient
        expect(hub).toEqual({
            folder: "src/hub",
            own: 1,
            files: 7,
            bytes: 6130,
            nodeModulesFiles: 4,
            otherFolderFiles: 2,
        });
        const withoutAmbient = folderClosures(graph, { ambient: false }).find((row) => row.folder === "src/hub");
        expect(withoutAmbient?.files).toBe(6);
    });

    it("ranks packages by bytes and lists their direct project importers", () => {
        const sizes = packageSizes(graph);
        expect(sizes.map((size) => size.name)).toEqual(["big", "@scope/pkg", "typescript", "inner"]);
        expect(sizes.find((size) => size.name === "@scope/pkg")?.importers).toEqual(["src/utils/u.ts"]);
        expect(sizes.find((size) => size.name === "inner")?.importers).toEqual([]);
    });

    it("finds the shortest chain from a project file", () => {
        expect(whyChain(graph, "inner/x")).toEqual([
            "src/utils/u.ts",
            "node_modules/@scope/pkg/index.d.ts",
            "node_modules/@scope/pkg/node_modules/inner/x.d.ts",
        ]);
        expect(whyChain(graph, "no-such-file")).toBeNull();
    });

    it("sums file costs per folder", () => {
        const rows = costByFolder([
            { file: "src/hub/a.ts", types: 1, instantiations: 2, symbols: 3, ms: 4, bytes: 0 },
            { file: "src/hub/b.ts", types: 10, instantiations: 20, symbols: 30, ms: 40, bytes: 0 },
        ]);
        expect(rows).toEqual([{ folder: "src/hub", files: 2, types: 11, instantiations: 22, symbols: 33, ms: 44 }]);
    });
});

describe("program sites and duplicates", () => {
    it("lists a package once per installed copy, the extra bytes being every copy after the largest", () => {
        const graph = graphOf([
            { path: "node_modules/@scope/pkg/index.d.ts", declaration: true, bytes: 1000 },
            { path: "node_modules/@scope/pkg/types.d.ts", declaration: true, bytes: 200 },
            { path: "node_modules/host/node_modules/@scope/pkg/index.d.ts", declaration: true, bytes: 300 },
            { path: "node_modules/single/index.d.ts", declaration: true, bytes: 50 },
        ]);
        expect(duplicatePackages(graph)).toEqual([
            {
                name: "@scope/pkg",
                copies: [
                    { folder: "node_modules/@scope/pkg", files: 2, bytes: 1200 },
                    { folder: "node_modules/host/node_modules/@scope/pkg", files: 1, bytes: 300 },
                ],
                extraBytes: 300,
            },
        ]);
    });

    it("groups sites by what they call, with the median and the costliest site", () => {
        const site = (key: string, line: number, instantiations: number): SiteCost => ({
            file: "src/a.ts",
            line,
            kind: "call",
            key,
            external: key.includes("node_modules"),
            instantiations,
            types: 1,
            symbols: 0,
            ms: 1,
        });
        const groups = groupSites([
            site("where @ kysely", 1, 100),
            site("where @ kysely", 2, 300),
            site("where @ kysely", 3, 200),
            site("render @ src/r.ts", 4, 5000),
        ]);
        expect(sortGroups(groups, "instantiations").map((group) => [group.key, group.instantiations])).toEqual([
            ["render @ src/r.ts", 5000],
            ["where @ kysely", 600],
        ]);
        const where = groups.find((group) => group.key === "where @ kysely");
        expect(where).toMatchObject({ sites: 3, files: 1, medianInstantiations: 200, max: { line: 2 } });
        expect(sortGroups(groups, "sites")[0]?.key).toBe("where @ kysely");
        // An even group averages its two middle sites.
        const pair = groupSites([site("cheap @ src/c.ts", 1, 50), site("cheap @ src/c.ts", 2, 5000)]);
        expect(pair[0]?.medianInstantiations).toBe(2525);
    });

    it("lists the sites of one key, keeping only project keys under --project-only", () => {
        const site = (key: string, instantiations: number): SiteCost => ({
            file: "src/a.ts",
            line: 1,
            kind: "call",
            key,
            external: key.includes("node_modules"),
            instantiations,
            types: 1,
            symbols: 0,
            ms: 1,
        });
        const sites = [
            site("where @ node_modules/kysely", 300),
            site("where @ src/db.ts", 100),
            site("render @ src/r.ts", 900),
        ];
        expect(sitesForKey(sites, "where", false).map((row) => row.key)).toEqual([
            "where @ node_modules/kysely",
            "where @ src/db.ts",
        ]);
        expect(sitesForKey(sites, "where", true).map((row) => row.key)).toEqual(["where @ src/db.ts"]);
    });
});

describe("program trace", () => {
    it("adds check time per file and lists hot events once per line, matching lowercased paths", () => {
        const source = "const a = 1;\nconst slow = make();\n";
        const traceJson = SafeJSON.stringify([
            { ph: "X", cat: "check", name: "checkSourceFile", ts: 0, dur: 300_000, args: { path: "/repo/src/a.ts" } },
            {
                ph: "X",
                cat: "check",
                name: "checkVariableDeclaration",
                ts: 0,
                dur: 120_000,
                args: { path: "/repo/src/a.ts", pos: 14 },
            },
            { ph: "B", cat: "check", name: "checkExpression", ts: 0, args: { path: "/repo/src/a.ts", pos: 20 } },
            { ph: "E", cat: "check", name: "checkExpression", ts: 110_000 },
            {
                ph: "X",
                cat: "check",
                name: "checkExpression",
                ts: 0,
                dur: 5_000,
                args: { path: "/repo/src/a.ts", pos: 0 },
            },
        ]);
        const report = analyzeTrace({ traceJson, root: "/Repo", minMs: 50, readSource: () => source });
        expect(report.checkMs).toBe(300);
        expect(report.files).toEqual([{ file: "src/a.ts", ms: 300 }]);
        expect(report.hotSpots).toEqual([
            { file: "src/a.ts", line: 2, event: "checkVariableDeclaration", ms: 120, source: "const slow = make();" },
        ]);
    });
});

/**
 * A project whose `typescript` blocks forever after writing what the child is (its pid and result path), so a
 * deadline or an abort is the only way the run can end. Atomics.wait blocks without using the CPU.
 */
function blockingProject(root: string): { tsconfig: string; started: (file: "index" | "tsc") => string } {
    const pkg = join(root, "node_modules", "typescript");
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), SafeJSON.stringify({ compilerOptions: { noEmit: true }, files: [] }));
    writeFileSync(
        join(pkg, "package.json"),
        SafeJSON.stringify({ name: "typescript", version: "0.0.0", main: "index.js" })
    );
    const blocker = [
        'const { renameSync, writeFileSync } = require("node:fs");',
        'const { join } = require("node:path");',
        "// Renamed into place, so a watcher that sees started.json reads it whole.",
        'writeFileSync(join(__dirname, "started.json.tmp"), JSON.stringify({ pid: process.pid, out: process.env.GT_TSP_OUT ?? null }));',
        'renameSync(join(__dirname, "started.json.tmp"), join(__dirname, "started.json"));',
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    ].join("\n");
    writeFileSync(join(pkg, "index.js"), blocker);
    writeFileSync(join(pkg, "lib", "tsc.js"), blocker);
    return {
        tsconfig: join(root, "tsconfig.json"),
        started: (file) => join(pkg, ...(file === "tsc" ? ["lib"] : []), "started.json"),
    };
}

interface Started {
    pid: number;
    out: string | null;
}

/** Wakes on the file event: the child writes the file within a second of starting on any machine. */
async function waitForStart(path: string): Promise<Started> {
    if (!(await waitForPath(path, { timeoutMs: 10_000 }))) {
        throw new Error(`the child never wrote ${path}`);
    }

    const started: Started = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    return started;
}

/** A killed child can stay a zombie until launchd reaps it, and it is not our child, so no exit event: poll with a deadline. */
async function waitForExit(pid: number): Promise<boolean> {
    const until = Date.now() + 5_000;

    while (Date.now() < until) {
        if (!isProcessAlive(pid)) {
            return true;
        }

        await Bun.sleep(100);
    }

    return false;
}

describe("program worker deadlines", () => {
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "gt-ts-program-deadline-"));
    });

    afterAll(() => {
        removeRecursive(root);
    });

    it("stops a check at its deadline, kills the child and removes the result folder", async () => {
        const project = blockingProject(join(root, "timeout"));
        const run = runProgramWorker("phases", { tsconfig: project.tsconfig, timeoutMs: 2_000 });
        // Handled before the wait, so a deadline that fires first is never an unhandled rejection. Bun's
        // `expect(run).rejects` blocks until the promise settles, so it cannot be the early handler itself.
        run.catch(() => undefined);
        const started = await waitForStart(project.started("index"));
        await expect(run).rejects.toThrow("the check did not finish in 2 s and was stopped; pass a larger --timeout");
        expect(await waitForExit(started.pid)).toBe(true);
        expect(started.out).not.toBeNull();
        expect(existsSync(dirname(started.out ?? ""))).toBe(false);
    }, 30_000);

    it("stops a check on abort, kills the child and removes the result folder", async () => {
        const project = blockingProject(join(root, "abort"));
        const controller = new AbortController();
        const run = runProgramWorker("phases", { tsconfig: project.tsconfig, signal: controller.signal });
        run.catch(() => undefined);
        const started = await waitForStart(project.started("index"));
        controller.abort();
        await expect(run).rejects.toThrow("the check was interrupted");
        expect(await waitForExit(started.pid)).toBe(true);
        expect(existsSync(dirname(started.out ?? ""))).toBe(false);
    }, 30_000);

    it("starts no child for a signal that is already aborted", async () => {
        const project = blockingProject(join(root, "aborted"));
        await expect(
            runProgramWorker("phases", { tsconfig: project.tsconfig, signal: AbortSignal.abort() })
        ).rejects.toThrow("the check was interrupted");
        expect(existsSync(project.started("index"))).toBe(false);
    }, 30_000);

    it("forwards the deadline to tsc --generateTrace and removes the partial trace", async () => {
        const project = blockingProject(join(root, "trace"));
        const traces = toolDataDir("ts", "traces");
        const before = existsSync(traces) ? readdirSync(traces) : [];
        const run = generateTrace({ tsconfig: project.tsconfig, timeoutMs: 1_500 });
        run.catch(() => undefined);
        const started = await waitForStart(project.started("tsc"));
        await expect(run).rejects.toThrow("tsc --generateTrace did not finish in 2 s and was stopped");
        expect(await waitForExit(started.pid)).toBe(true);
        expect(existsSync(traces) ? readdirSync(traces) : []).toEqual(before);
    }, 30_000);
});

describe("program worker (node)", () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-ts-program-test-"));
        mkdirSync(join(dir, "src"));
        writeFileSync(
            join(dir, "tsconfig.json"),
            SafeJSON.stringify({
                compilerOptions: { strict: true, noEmit: true, lib: ["ES2022"] },
                include: ["src/**/*"],
            })
        );
        writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
        writeFileSync(join(dir, "src", "a.ts"), 'import { b } from "./b";\nexport const a: number = b + 1;\n');
        writeFileSync(join(dir, "src", "bad.ts"), 'export const bad: number = "text";\n');
        writeFileSync(join(dir, "src", "globals.d.ts"), "declare const BUILD_ID: string;\n");
    });

    afterAll(() => {
        removeRecursive(dir);
    });

    it("measures phases, one file's own cost, and the import graph of a real program", async () => {
        const tsconfig = join(dir, "tsconfig.json");
        const phases = await runProgramWorker("phases", { tsconfig });
        expect(phases.phases.map((phase) => phase.phase)).toEqual(["start", "parse", "bind", "check"]);
        expect(phases.gcForced).toBe(true);
        expect(phases.diagnostics).toBe(1);
        expect(phases.firstDiagnostics[0]).toContain("src/bad.ts(1,14): TS2322");

        const own = await runProgramWorker("own", {
            tsconfig,
            files: [join(dir, "src", "a.ts"), join(dir, "src", "bad.ts")],
        });
        expect(own.rows.map((row) => [row.file, row.diagnostics.length])).toEqual([
            ["src/a.ts", 0],
            ["src/bad.ts", 1],
        ]);

        const graph = await runProgramWorker("graph", { tsconfig });
        const a = graph.files.find((file) => file.path === "src/a.ts");
        expect(a?.imports.map((at) => graph.files[at]?.path)).toEqual(["src/b.ts"]);
        expect(graph.files.find((file) => file.path === "src/globals.d.ts")).toMatchObject({
            root: true,
            declaration: true,
        });
        expect(graph.files.some((file) => file.base && file.declaration)).toBe(true);
    }, 60_000);

    it("charges a call with its arguments, so a contextually typed inner call is not blamed for the outer one", async () => {
        const project = join(dir, "sites");
        mkdirSync(join(project, "src"), { recursive: true });
        writeFileSync(
            join(project, "tsconfig.json"),
            SafeJSON.stringify({
                compilerOptions: { strict: true, noEmit: true, lib: ["ES2022"] },
                include: ["src/**/*"],
            })
        );
        // Overload resolution is the outer call's own work; the arguments' contextual type needs it resolved.
        const overloads = Array.from(
            { length: 60 },
            (_, at) => `declare function outer<T extends { tag: { tag: "a${at}" } }>(value: T): T;`
        );
        writeFileSync(
            join(project, "src", "s.ts"),
            [
                ...overloads,
                "declare function outer<T extends { tag: { tag: string } }>(value: T): T;",
                "declare function inner<const V extends string>(value: V): { tag: V };",
                'export const built = outer({ tag: inner("x"), other: inner("y") });',
                "",
            ].join("\n")
        );
        const result = await runProgramWorker("sites", { tsconfig: join(project, "tsconfig.json") });
        const outerSite = result.sites.find((site) => site.key.startsWith("outer @ src/s.ts"));
        expect(outerSite).toMatchObject({ file: "src/s.ts", line: 63, kind: "call", external: false });
        expect(outerSite?.instantiations ?? 0).toBeGreaterThanOrEqual(result.minInstantiations);

        for (const site of result.sites.filter((row) => row.key.startsWith("inner @"))) {
            expect(site.instantiations).toBeLessThan(outerSite?.instantiations ?? 0);
        }
    }, 60_000);

    it("reports the tsconfig's own errors instead of 0 diagnostics", async () => {
        const broken = join(dir, "broken");
        mkdirSync(join(broken, "src"), { recursive: true });
        writeFileSync(
            join(broken, "tsconfig.json"),
            SafeJSON.stringify({ compilerOptions: { noEmit: true, notARealOption: true }, include: ["src/**/*"] })
        );
        writeFileSync(join(broken, "src", "x.ts"), "export const x = 1;\n");
        const phases = await runProgramWorker("phases", { tsconfig: join(broken, "tsconfig.json") });
        expect(phases.diagnostics).toBe(1);
        expect(phases.firstDiagnostics[0]).toContain("TS5023");
    }, 60_000);

    it("resolves each import with its own mode, so ESM and CommonJS reach different declaration files", async () => {
        const dual = join(dir, "dual");
        const pkg = join(dual, "node_modules", "dual");
        mkdirSync(join(dual, "src"), { recursive: true });
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
            join(dual, "tsconfig.json"),
            SafeJSON.stringify({
                compilerOptions: {
                    module: "nodenext",
                    moduleResolution: "nodenext",
                    strict: true,
                    noEmit: true,
                    types: [],
                },
                include: ["src/**/*"],
            })
        );
        writeFileSync(
            join(pkg, "package.json"),
            SafeJSON.stringify({
                name: "dual",
                version: "1.0.0",
                exports: { ".": { import: { types: "./esm.d.ts" }, require: { types: "./cjs.d.ts" } } },
            })
        );
        writeFileSync(join(pkg, "esm.d.ts"), "export declare const esm: number;\n");
        writeFileSync(join(pkg, "cjs.d.ts"), "export declare const cjs: number;\n");
        writeFileSync(join(dual, "src", "a.mts"), 'import { esm } from "dual";\nexport const a = esm;\n');
        writeFileSync(join(dual, "src", "b.cts"), 'import dual = require("dual");\nexport const b = dual.cjs;\n');
        // A type reference resolves with its own resolution-mode, not the file's (a .cts asking for the import branch).
        writeFileSync(
            join(dual, "src", "c.cts"),
            '/// <reference types="dual" resolution-mode="import" />\nexport {};\n'
        );
        writeFileSync(
            join(dual, "src", "d.mts"),
            'export const load = () => import("dual");\nexport type Dual = typeof import("dual");\n'
        );
        // A require() call in a TypeScript file is no import (TypeScript resolves it only in JavaScript files), and
        // before binding its string literal has no parent node.
        writeFileSync(
            join(dual, "src", "e.ts"),
            'declare const require: (id: string) => unknown;\nexport const e = require("dual");\n'
        );
        const graph = await runProgramWorker("graph", { tsconfig: join(dual, "tsconfig.json") });
        const edges = (path: string) =>
            graph.files.find((file) => file.path === path)?.imports.map((at) => graph.files[at]?.path);
        expect(edges("src/a.mts")).toEqual(["node_modules/dual/esm.d.ts"]);
        expect(edges("src/b.cts")).toEqual(["node_modules/dual/cjs.d.ts"]);
        expect(edges("src/c.cts")).toEqual(["node_modules/dual/esm.d.ts"]);
        expect(edges("src/d.mts")).toEqual(["node_modules/dual/esm.d.ts"]);
        expect(edges("src/e.ts")).toEqual([]);
    }, 60_000);

    it("reports a parse error as a diagnostic and links a TSX file to the JSX runtime it never imports", async () => {
        const project = join(dir, "jsx");
        const react = join(project, "node_modules", "react");
        mkdirSync(join(project, "src"), { recursive: true });
        mkdirSync(react, { recursive: true });
        writeFileSync(
            join(project, "tsconfig.json"),
            SafeJSON.stringify({
                compilerOptions: {
                    jsx: "react-jsx",
                    module: "esnext",
                    moduleResolution: "bundler",
                    noEmit: true,
                    types: [],
                },
                include: ["src/**/*"],
            })
        );
        writeFileSync(join(react, "package.json"), SafeJSON.stringify({ name: "react", version: "19.0.0" }));
        writeFileSync(
            join(react, "jsx-runtime.d.ts"),
            "export declare function jsx(type: unknown, props: unknown): unknown;\n"
        );
        writeFileSync(join(project, "src", "view.tsx"), "export const view = <div />;\n");
        writeFileSync(join(project, "src", "broken.ts"), "export const broken = ;\n");
        const tsconfig = join(project, "tsconfig.json");

        const own = await runProgramWorker("own", { tsconfig, files: [join(project, "src", "broken.ts")] });
        expect(own.rows[0]?.diagnostics.some((line) => line.includes("TS1109"))).toBe(true);

        const graph = await runProgramWorker("graph", { tsconfig });
        const view = graph.files.find((file) => file.path === "src/view.tsx");
        expect(view?.imports.map((at) => graph.files[at]?.path)).toEqual(["node_modules/react/jsx-runtime.d.ts"]);
    }, 60_000);

    it("includes automatic typeRoots declarations in every folder closure, respecting an explicit empty types list", async () => {
        const project = join(dir, "automatic-types");
        const globals = join(project, "node_modules", "@types", "fixture-globals");
        mkdirSync(join(project, "src", "a"), { recursive: true });
        mkdirSync(join(project, "src", "b"), { recursive: true });
        mkdirSync(globals, { recursive: true });
        writeFileSync(join(globals, "index.d.ts"), "declare const FIXTURE_GLOBAL: string;\n");
        writeFileSync(join(project, "src", "a", "index.ts"), "export const a = FIXTURE_GLOBAL;\n");
        writeFileSync(join(project, "src", "b", "index.ts"), "export const b = 1;\n");
        const tsconfig = join(project, "tsconfig.json");
        const compilerOptions = { noEmit: true, lib: ["ES2022"], types: ["*"], typeRoots: ["./node_modules/@types"] };
        writeFileSync(tsconfig, SafeJSON.stringify({ compilerOptions, include: ["src/**/*"] }));
        const graph = await runProgramWorker("graph", { tsconfig });
        expect(
            graph.files.find((file) => file.path === "node_modules/@types/fixture-globals/index.d.ts")
        ).toMatchObject({ base: true });
        const withGlobals = folderClosures(graph);

        writeFileSync(
            tsconfig,
            SafeJSON.stringify({ compilerOptions: { ...compilerOptions, types: [] }, include: ["src/**/*"] })
        );
        const withoutTypes = await runProgramWorker("graph", { tsconfig });
        expect(withoutTypes.files.some((file) => file.path.includes("fixture-globals"))).toBe(false);
        const withoutGlobals = folderClosures(withoutTypes);
        expect(withGlobals.map((row) => row.folder)).toEqual(withoutGlobals.map((row) => row.folder));
        expect(withGlobals.map((row) => row.nodeModulesFiles)).toEqual(
            withoutGlobals.map((row) => row.nodeModulesFiles + 1)
        );
    }, 60_000);

    it("reports a heap that is too small as a usage error, not a stack dump", async () => {
        const tsconfig = join(dir, "tsconfig.json");
        await expect(runProgramWorker("phases", { tsconfig, heapMiB: 8 })).rejects.toThrow(
            /does not fit in 8 MiB of heap/
        );
    }, 60_000);
});
