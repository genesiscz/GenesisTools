import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { PROFILER_SCOPE_NAMES } from "@genesiscz/utils/profile";
import { stripAnsi } from "@genesiscz/utils/string";
import { captureOut } from "@genesiscz/utils/test/capture-out";
import { parsePositive, resolveEntries } from "../commands/imports";
import { renderSymbol } from "../commands/skeleton";
import { computeTotals } from "./analyze";
import { attribute, isBarrel, nativeSignals } from "./attribute";
import { type BarrelWaste, findBarrelWaste } from "./barrels";
import { collectFiles } from "./collect";
import { findCycles, type ImportCycle } from "./cycles";
import { buildGraph, isLoadTimeEdge, isMeasuredEdge, labelFor, packageNameOf, postOrder, reachableFrom } from "./graph";
import { findLazyCandidates, type LazyCandidate } from "./lazy";
import type { WorkerSample } from "./measure";
import { parseModule } from "./parse";
import { fanInOf, packByBudget, rankFiles } from "./rank";
import { fmtMs, renderAnalysis, renderBarrels, renderCycles, renderLazy } from "./render";
import { exportedOnly, extractSkeleton, parseSource, type SkeletonSymbol } from "./skeleton";
import { collectTypeNames, expandTypes } from "./type-expand";
import type {
    AnalysisResult,
    AnalyzedModule,
    Finding,
    GraphEdge,
    GraphNode,
    ImportGraph,
    ImportSite,
    NodeKind,
} from "./types";

let root: string;

function write(rel: string, source: string): string {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, source);
    return file;
}

function samples(entries: Record<string, number>): Map<string, WorkerSample> {
    const map = new Map<string, WorkerSample>();

    for (const [rel, ms] of Object.entries(entries)) {
        map.set(join(root, rel), { ms, status: "ok" });
    }

    return map;
}

/**
 * One fixture tree, one graph, many assertions. Shape:
 *
 *   entry.ts ─┬─ barrel/index.ts ─┬─ barrel/a.ts (used)
 *             │                   ├─ barrel/b.ts (unused) ── heavy.ts
 *             │                   └─ barrel/c.ts (unused, type-only re-export)
 *             ├─ lazy-ok.ts       (bindings used only inside functions)
 *             ├─ eager.ts         (binding used at module scope)
 *             ├─ cyc/x.ts ⇄ cyc/y.ts
 *             ├─ node_modules/fake-native  (napi manifest)
 *             ├─ node_modules/plain
 *             ├─ dyn.ts via import()
 *             └─ types.ts via `import type` (never a node)
 */
beforeAll(() => {
    // realpath: Bun.resolveSync returns real paths, and macOS tmp lives under a /var symlink.
    root = realpathSync(mkdtempSync(join(tmpdir(), "gt-ts-test-")));
    mkdirSync(join(root, ".git"));
    write(
        "entry.ts",
        [
            'import { a } from "./barrel";',
            'import { helper } from "./lazy-ok";',
            'import { NOW } from "./eager";',
            'import { x } from "./cyc/x";',
            'import native from "fake-native";',
            'import plain from "plain";',
            'import type { Shape } from "./types";',
            "export const stamp = NOW + 1;",
            "export function run(shape: Shape) { return helper() + a() + x() + native + plain; }",
            'export async function later() { return (await import("./dyn")).default; }',
        ].join("\n")
    );
    write("barrel/index.ts", 'export { a } from "./a";\nexport * from "./b";\nexport type { T } from "./c";');
    write("barrel/a.ts", "export function a() { return 1; }");
    write("barrel/b.ts", 'import { heavy } from "../heavy";\nexport function b() { return heavy; }');
    write("barrel/c.ts", "export type T = string;");
    write("heavy.ts", "export const heavy = 42;");
    write("lazy-ok.ts", 'import { readFileSync } from "node:fs";\nexport function helper() { return readFileSync; }');
    write("eager.ts", "export const NOW = Date.now();\nsetInterval(() => {}, 1000);");
    write("cyc/x.ts", 'import { y } from "./y";\nexport function x() { return y; }');
    write("cyc/y.ts", 'import { x } from "./x";\nexport const y = () => x;');
    write("dyn.ts", "export default 7;");
    write("types.ts", "export interface Shape { n: number }");
    write(
        "node_modules/fake-native/package.json",
        '{ "name": "fake-native", "main": "index.js", "napi": { "name": "fake" }, "optionalDependencies": { "fake-native-darwin-arm64": "1.0.0" } }'
    );
    write("node_modules/fake-native/index.js", 'module.exports = require("./fake.node");');
    write("node_modules/plain/package.json", '{ "name": "plain", "main": "index.js" }');
    write("node_modules/plain/index.js", "module.exports = 1;");
});

afterAll(() => {
    // The tmp tree is left for the OS; a test never deletes.
});

describe("parseModule", () => {
    it("separates value imports from type-only ones and keeps aliases", () => {
        const parsed = parseModule(
            'import type { A } from "./a";\nimport { type B, c, d as e } from "./b";\nimport * as ns from "./ns";\nimport "./side";',
            "probe.ts"
        );
        expect(parsed.imports.map((site) => [site.specifier, site.typeOnly, site.kind])).toEqual([
            ["./a", true, "static"],
            ["./b", false, "static"],
            ["./ns", false, "static"],
            ["./side", false, "side-effect"],
        ]);
        expect(parsed.imports[1].names).toEqual(["c", "d"]);
        expect(parsed.imports[1].locals).toEqual(["c", "e"]);
        expect(parsed.imports[2].names).toEqual(["*"]);
    });

    it("knows which imported bindings are touched at module scope", () => {
        const parsed = parseModule(
            'import { a, b, c, d, e } from "./m";\nconst v = a.x;\nfunction f() { return b(); }\nexport { c };\nclass K { static { d(); } static x = e(); m() { b(); } }',
            "probe.ts"
        );
        expect([...parsed.moduleScopeUses].sort()).toEqual(["a", "c", "d", "e"]);
        expect([...parsed.reexportedLocals]).toEqual(["c"]);
    });

    it("classifies module-scope work and skips cheap literals", () => {
        const parsed = parseModule(
            [
                'import { Database } from "bun:sqlite";',
                'const db = new Database("x.db");',
                "setInterval(() => {}, 5);",
                'const names = new Set(["a"]);',
                'const p = join("a", "b");',
                "const v = await load();",
                "if (import.meta.main) { run(); }",
                "try { require('./opt.node'); } catch (e) { fallback(); }",
            ].join("\n"),
            "probe.ts"
        );
        expect(parsed.sideEffects.map((effect) => [effect.kind, effect.line])).toEqual([
            ["db", 2],
            ["timer", 3],
            ["await", 6],
        ]);
    });

    it("treats class static fields and static blocks as module-scope work", () => {
        const parsed = parseModule(
            [
                "class K {",
                "    static { setInterval(() => {}, 1); }",
                "    static x = setTimeout(() => {}, 1);",
                "    y = setImmediate(() => {});",
                "    m() { queueMicrotask(() => {}); }",
                "}",
            ].join("\n"),
            "probe.ts"
        );
        expect(parsed.sideEffects.map((effect) => [effect.kind, effect.line])).toEqual([
            ["timer", 2],
            ["timer", 3],
        ]);
    });

    it("records re-exports, declared export names and dynamic imports", () => {
        const parsed = parseModule(
            'export * from "./x";\nexport { y as yy } from "./y";\nexport const { p, q } = obj;\nexport function f() {}\nexport default f;\nconst m = () => import("./lazy");\nconst r = require("./cjs");',
            "probe.ts"
        );
        expect(parsed.reexports.map((site) => site.names)).toEqual([["*"], ["y"]]);
        expect([...parsed.exportNames].sort()).toEqual(["default", "f", "p", "q"]);
        expect(parsed.imports.find((site) => site.specifier === "./lazy")?.kind).toBe("dynamic");
        expect(parsed.imports.find((site) => site.specifier === "./lazy")?.awaited).toBeUndefined();
        expect(parsed.imports.find((site) => site.specifier === "./cjs")?.kind).toBe("require");
        expect(parsed.localExports).toBe(2);
    });

    it("marks module-scope await import() as awaited and function-scope import() as not", () => {
        const parsed = parseModule(
            'const m = await import("./heavy");\nexport async function later() { return import("./fn"); }',
            "probe.ts"
        );
        expect(parsed.imports.find((site) => site.specifier === "./heavy")).toMatchObject({
            kind: "dynamic",
            awaited: true,
        });
        expect(parsed.imports.find((site) => site.specifier === "./fn")).toMatchObject({ kind: "dynamic" });
        expect(parsed.imports.find((site) => site.specifier === "./fn")?.awaited).toBeUndefined();
        const heavy = parsed.imports.find((site) => site.specifier === "./heavy");
        const fn = parsed.imports.find((site) => site.specifier === "./fn");

        if (!heavy || !fn) {
            throw new Error("expected both import() sites");
        }

        expect(isLoadTimeEdge(heavy)).toBe(true);
        expect(isLoadTimeEdge(fn)).toBe(false);
        expect(isMeasuredEdge(fn, false)).toBe(false);
        expect(isMeasuredEdge(fn, true)).toBe(true);
    });
});

describe("buildGraph", () => {
    it("walks static edges, records dynamic ones, drops type-only ones, and treats packages as leaves", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const labels = [...graph.nodes.values()].map((node) => node.label).sort();
        expect(labels).toContain("barrel/index.ts");
        expect(labels).toContain("heavy.ts");
        expect(labels).toContain("pkg:fake-native");
        expect(labels).toContain("pkg:plain");
        expect(labels).toContain("node:fs");
        expect(labels).not.toContain("types.ts");
        expect(labels).not.toContain("barrel/c.ts");
        // dyn.ts is a node (so lazy/cycles can name it) but nothing under it is walked
        expect(labels).toContain("dyn.ts");
        expect(graph.nodes.get(join(root, "dyn.ts"))?.parsed).toBeUndefined();
        expect(graph.nodes.get(join(root, "node_modules/plain/index.js"))?.kind).toBe("package");
        expect(graph.unresolved).toEqual([]);
    });

    it("post-orders children before parents and reports reachability", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const order = postOrder(graph, join(root, "entry.ts"));
        expect(order[order.length - 1]).toBe(join(root, "entry.ts"));
        expect(order.indexOf(join(root, "heavy.ts"))).toBeLessThan(order.indexOf(join(root, "barrel/b.ts")));
        expect(order.indexOf(join(root, "barrel/b.ts"))).toBeLessThan(order.indexOf(join(root, "barrel/index.ts")));
        const reach = reachableFrom(graph, join(root, "entry.ts"));
        expect(reach.has(join(root, "heavy.ts"))).toBe(true);
        expect(reach.has(join(root, "dyn.ts"))).toBe(false);
        expect(
            reachableFrom(graph, join(root, "entry.ts"), {
                from: join(root, "entry.ts"),
                to: join(root, "barrel/index.ts"),
            }).has(join(root, "heavy.ts"))
        ).toBe(false);
    });

    it("follows dynamic imports when asked, without treating them as load-time", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root, includeDynamic: true });
        expect(graph.nodes.get(join(root, "dyn.ts"))?.parsed).toBeDefined();
        expect(postOrder(graph, join(root, "entry.ts"))).toContain(join(root, "dyn.ts"));
        expect(reachableFrom(graph, join(root, "entry.ts")).has(join(root, "dyn.ts"))).toBe(false);
    });

    it("walks a module that was first seen as a dynamic placeholder once a static import reaches it", () => {
        write("dyn-first.ts", 'export async function load() { return import("./shared"); }');
        write("stat-later.ts", 'import { x } from "./shared";\nexport const y = x;');
        write("shared.ts", 'import { leaf } from "./leaf";\nexport const x = leaf;');
        write("leaf.ts", "export const leaf = 1;");
        write("mix-entry.ts", 'import "./dyn-first";\nimport "./stat-later";');
        const graph = buildGraph({ entry: join(root, "mix-entry.ts"), root });
        expect(graph.nodes.get(join(root, "shared.ts"))?.parsed).toBeDefined();
        expect(reachableFrom(graph, join(root, "mix-entry.ts")).has(join(root, "leaf.ts"))).toBe(true);
    });

    it("follows module-scope await import() as a load-time edge without --include-dynamic", () => {
        write("await-heavy.ts", "export const n = 1;");
        write("await-entry.ts", 'const mod = await import("./await-heavy");\nexport const v = mod;');
        const graph = buildGraph({ entry: join(root, "await-entry.ts"), root });
        expect(graph.nodes.get(join(root, "await-heavy.ts"))?.parsed).toBeDefined();
        expect(reachableFrom(graph, join(root, "await-entry.ts")).has(join(root, "await-heavy.ts"))).toBe(true);
    });

    it("stores unresolved specifiers with repo-relative labels", () => {
        write("unresolved-entry.ts", 'import { x } from "./no-such-module";\nexport const y = 1;');
        const graph = buildGraph({ entry: join(root, "unresolved-entry.ts"), root });
        expect(graph.unresolved).toEqual([{ from: "unresolved-entry.ts", specifier: "./no-such-module", line: 1 }]);
    });

    it("names packages from their node_modules path", () => {
        expect(packageNameOf("/r/node_modules/@scope/name/lib/x.js")).toBe("@scope/name");
        expect(packageNameOf("/r/node_modules/name/index.js")).toBe("name");
        expect(packageNameOf("/r/src/x.ts")).toBeUndefined();
        expect(labelFor("/r/node_modules/name/index.js", "/r")).toBe("pkg:name");
        expect(labelFor("/r/node_modules/name/lib/deep.js", "/r")).toBe("pkg:name/lib/deep.js");
        expect(labelFor("/r/src/x.ts", "/r")).toBe("src/x.ts");
    });
});

describe("totals and attribution", () => {
    it("sums self over the static subtree and marks the cycle carrier", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const order = postOrder(graph, join(root, "entry.ts"));
        const self = samples({
            "entry.ts": 1,
            "barrel/index.ts": 0.5,
            "barrel/a.ts": 0.25,
            "barrel/b.ts": 0.25,
            "heavy.ts": 10,
            "lazy-ok.ts": 2,
            "eager.ts": 3,
            "cyc/x.ts": 0,
            "cyc/y.ts": 4,
            "node_modules/fake-native/index.js": 20,
            "node_modules/plain/index.js": 1,
        });
        const totals = computeTotals(graph, self, order);
        const barrel = totals.get(join(root, "barrel/index.ts"));
        expect(barrel?.totalMs).toBe(11);
        expect(barrel?.descendants).toBe(3);
        expect(totals.get(join(root, "entry.ts"))?.totalMs).toBeCloseTo(42, 5);
        const x = totals.get(join(root, "cyc/x.ts"));
        const y = totals.get(join(root, "cyc/y.ts"));
        expect(x?.cycle?.size).toBe(2);
        expect(y?.cycle?.paidBy).toBe("cyc/y.ts");
        expect(x?.cycle?.paidBy).toBe("cyc/y.ts");
        expect(totals.get("node:fs")?.measured).toBe(false);
    });

    it("explains a native package from its manifest and source", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const native = graph.nodes.get(join(root, "node_modules/fake-native/index.js"));
        const plain = graph.nodes.get(join(root, "node_modules/plain/index.js"));

        if (!native || !plain) {
            throw new Error("fixture packages missing from graph");
        }

        expect(nativeSignals(native)).toEqual([
            'package.json declares "napi"',
            "1 per-platform binary packages (fake-native-darwin-arm64, …)",
            "source mentions .node",
        ]);
        expect(nativeSignals(plain)).toEqual([]);

        const findings = attribute({
            node: native,
            measured: { id: native.id, selfMs: 20, totalMs: 20, descendants: 0, measured: true },
            slowMs: 1,
            largeSubtreeMs: 5,
        });
        expect(findings.map((finding) => finding.kind)).toEqual(["native-addon"]);
    });

    it("flags a timer at module scope, an exit during import, and a barrel", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const eager = graph.nodes.get(join(root, "eager.ts"));
        const barrel = graph.nodes.get(join(root, "barrel/index.ts"));

        if (!eager || !barrel) {
            throw new Error("fixture modules missing from graph");
        }

        const eagerFindings = attribute({
            node: eager,
            measured: { id: eager.id, selfMs: 3, totalMs: 3, descendants: 0, measured: true, importError: "exit 1" },
            slowMs: 1,
            largeSubtreeMs: 5,
        });
        expect(eagerFindings.map((finding) => finding.kind)).toEqual(["exits-on-import", "side-effects"]);
        expect(eagerFindings[1].details[0]).toContain("eager.ts:2  setInterval");
        expect(isBarrel(barrel)).toBe(true);
        expect(isBarrel(eager)).toBe(false);
    });
});

describe("companion analyses", () => {
    it("finds the unused re-export a barrel drags in and prices it by exclusive self time", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const self = samples({ "barrel/index.ts": 0.5, "barrel/a.ts": 0.25, "barrel/b.ts": 0.25, "heavy.ts": 10 });
        const waste = findBarrelWaste(graph, self);
        expect(waste).toHaveLength(1);
        expect(waste[0]).toMatchObject({
            importer: "entry.ts",
            barrel: "barrel/index.ts",
            used: ["a"],
            usedTargets: ["barrel/a.ts"],
            unusedTargets: ["barrel/b.ts"],
            // the barrel itself leaves the path too once the importer reaches barrel/a.ts directly
            wastedModules: 3,
            wastedMs: 10.75,
        });
    });

    it("offers only imports whose bindings stay out of module scope as lazy candidates", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const self = samples({ "lazy-ok.ts": 2, "eager.ts": 3, "barrel/index.ts": 0.5, "heavy.ts": 10, "cyc/y.ts": 4 });
        const candidates = findLazyCandidates(graph, self);
        const targets = candidates.map((candidate) => candidate.target);
        expect(targets).toContain("lazy-ok.ts");
        expect(targets).toContain("barrel/index.ts");
        expect(targets).not.toContain("eager.ts");
        // cyc/x.ts is imported by entry with x() used only in run(): a candidate whose saving is the cycle
        expect(candidates.find((candidate) => candidate.target === "barrel/index.ts")?.savingMs).toBe(10.5);
        expect(candidates[0].target).toBe("barrel/index.ts");
        expect(candidates.find((candidate) => candidate.target === "lazy-ok.ts")?.exclusiveModules).toBe(2);
    });

    it("finds the two-module cycle and nothing else", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root });
        const cycles = findCycles(graph, samples({ "cyc/x.ts": 0, "cyc/y.ts": 4 }));
        expect(cycles).toHaveLength(1);
        expect(cycles[0].members).toEqual(["cyc/x.ts", "cyc/y.ts"]);
        expect([...cycles[0].memberIds].sort()).toEqual([join(root, "cyc/x.ts"), join(root, "cyc/y.ts")].sort());
        expect(cycles[0].selfMs).toBe(4);
        expect(cycles[0].edges).toHaveLength(2);
    });

    it("does not report a deferred import() cycle even with --include-dynamic", () => {
        write("dyn-cyc/a.ts", 'export async function go() { return import("./b"); }\nexport const a = 1;');
        write("dyn-cyc/b.ts", 'export async function go() { return import("./a"); }\nexport const b = 1;');
        write("dyn-cyc/entry.ts", 'import { a } from "./a";\nexport const v = a;');
        const graph = buildGraph({ entry: join(root, "dyn-cyc/entry.ts"), root, includeDynamic: true });
        expect(graph.nodes.get(join(root, "dyn-cyc/b.ts"))?.parsed).toBeDefined();
        expect(findCycles(graph)).toEqual([]);
    });

    it("does not count a mixed barrel's own module as waste when the importer uses a local export", () => {
        write("mix-barrel/index.ts", 'export const local = 1;\nexport { a } from "./a";\nexport { b } from "./b";');
        write("mix-barrel/a.ts", "export function a() { return 1; }");
        write("mix-barrel/b.ts", "export function b() { return 2; }");
        write("mix-entry-local.ts", 'import { local, a } from "./mix-barrel";\nexport const v = local + a();');
        const graph = buildGraph({ entry: join(root, "mix-entry-local.ts"), root });
        const self = samples({ "mix-barrel/index.ts": 5, "mix-barrel/a.ts": 1, "mix-barrel/b.ts": 2 });
        const waste = findBarrelWaste(graph, self);
        expect(waste).toHaveLength(1);
        expect(waste[0]).toMatchObject({
            importer: "mix-entry-local.ts",
            barrel: "mix-barrel/index.ts",
            used: ["local", "a"],
            usedTargets: ["mix-barrel/a.ts"],
            unusedTargets: ["mix-barrel/b.ts"],
            wastedModules: 1,
            wastedMs: 2,
        });
    });
});

describe("resolveEntries", () => {
    it("takes a file, a directory's index, a directory's sources, or a tsconfig", () => {
        expect(resolveEntries(join(root, "entry.ts"))).toEqual([join(root, "entry.ts")]);
        expect(resolveEntries(join(root, "barrel"))).toEqual([join(root, "barrel/index.ts")]);
        write("many/one.ts", "export const one = 1;");
        write("many/two.test.ts", "export const two = 2;");
        write("many/three.d.ts", "export declare const three: number;");
        write("many/tsconfig.json", "{}");
        expect(resolveEntries(join(root, "many"))).toEqual([join(root, "many/one.ts")]);
        expect(resolveEntries(join(root, "many/tsconfig.json"))).toEqual([join(root, "many/one.ts")]);
        expect(resolveEntries(join(root, "missing"))).toEqual([]);
    });
});

describe("parsePositive", () => {
    it("rejects zero, negatives and non-numeric strings", () => {
        const previous = process.exitCode;
        process.exitCode = 0;
        expect(parsePositive(undefined, 60, "--timeout")).toBe(60);
        expect(parsePositive("25", 60, "--timeout")).toBe(25);
        expect(parsePositive("0", 60, "--timeout")).toBeUndefined();
        expect(parsePositive("-1", 60, "--timeout")).toBeUndefined();
        expect(parsePositive("abc", 3, "--runs")).toBeUndefined();
        expect(process.exitCode).toBe(1);
        process.exitCode = previous ?? 0;
    });
});

describe("profiler scope", () => {
    it("registers ts so PROFILE=ts and --scopes can name it", () => {
        expect(PROFILER_SCOPE_NAMES).toContain("ts");
    });
});

describe("extractSkeleton", () => {
    const source = `export const LIMIT = 5;
export function add(a: number, b: number): number {
    return a + b;
}
function hidden(): void {}
export interface Shape {
    area(): number;
}
export type Id = string;
export class Box {
    constructor(private size: number) {}
    get volume(): number {
        return this.size ** 3;
    }
    grow(by: number): void {
        this.size += by;
    }
}
export const scale = (value: number) => value * 2;
`;

    const symbols = extractSkeleton(parseSource("demo.ts", source));
    const byName = (name: string) => symbols.find((symbol) => symbol.name === name);

    it("captures the signature head without the body", () => {
        expect(byName("add")?.signature).toBe("export function add(a: number, b: number): number");
        expect(byName("add")?.kind).toBe("function");
    });

    it("records the line span of a declaration", () => {
        expect(byName("add")?.startLine).toBe(2);
        expect(byName("add")?.endLine).toBe(4);
    });

    it("marks exported declarations and leaves local ones unexported", () => {
        expect(byName("add")?.exported).toBe(true);
        expect(byName("hidden")?.exported).toBe(false);
    });

    it("treats an arrow constant as a function and a plain constant as a const", () => {
        expect(byName("scale")?.kind).toBe("function");
        expect(byName("LIMIT")?.kind).toBe("const");
    });

    it("descends into class and interface members at depth 1", () => {
        expect(byName("grow")).toMatchObject({ kind: "method", depth: 1 });
        expect(byName("volume")?.kind).toBe("getter");
        expect(byName("constructor")?.kind).toBe("constructor");
        expect(byName("area")).toMatchObject({ kind: "method", depth: 1 });
        expect(byName("Box")?.depth).toBe(0);
    });

    it("reports a re-export barrel, which declares nothing but is not empty", () => {
        const barrel = extractSkeleton(
            parseSource("barrel.ts", `export { parseTurnEvents, toWorkerEvents } from "./worker-stream";\n`)
        );

        expect(barrel).toHaveLength(1);
        expect(barrel[0]).toMatchObject({ kind: "re-export", name: "parseTurnEvents, toWorkerEvents", exported: true });
        expect(barrel[0]?.depth).toBe(0);
    });

    it("lists interface fields, which used to be omitted entirely", () => {
        const fields = extractSkeleton(
            parseSource("shape.ts", `export interface Point {\n    x: number;\n    label?: string;\n}\n`)
        );

        expect(fields.map((symbol) => symbol.name)).toEqual(["Point", "x", "label"]);
        expect(fields[1]).toMatchObject({ kind: "field", depth: 1, signature: "x: number;" });
    });

    it("does not drag a member's JSDoc into the declaration head", () => {
        const [head] = extractSkeleton(
            parseSource("doc.ts", `export interface Doc {\n    /** a long comment */\n    id: string;\n}\n`)
        );

        expect(head?.signature).toBe("export interface Doc");
    });

    it("reports a namespace and a declare module with their bodies", () => {
        const nested = extractSkeleton(
            parseSource(
                "ns.ts",
                `namespace NS {\n    export const x = 1;\n}\ndeclare module "pkg" {\n    export const y: number;\n}\n`
            )
        );

        expect(nested.map((symbol) => symbol.kind)).toEqual(["namespace", "const", "namespace", "const"]);
        expect(nested[1]?.depth).toBe(1);
    });

    it("treats a class arrow property as a method", () => {
        const cls = extractSkeleton(
            parseSource("cls.ts", `export class A {\n    handler = (e: string): void => {};\n}\n`)
        );

        expect(cls[1]).toMatchObject({ kind: "method", name: "handler", depth: 1 });
    });

    it("reports a top-level call, so a commander entrypoint is not blank", () => {
        const calls = extractSkeleton(parseSource("entry.ts", `registerCommands(program);\n`));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ kind: "call", signature: "registerCommands(program);" });
    });

    it("drops the dangling arrow from a generic arrow signature", () => {
        const [arrow] = extractSkeleton(parseSource("g.ts", `export const id = <T,>(v: T): T => v;\n`));

        expect(arrow?.signature.endsWith("=>")).toBe(false);
    });

    it("keeps interfaces, types and classes as top-level entries", () => {
        expect(byName("Shape")?.kind).toBe("interface");
        expect(byName("Id")?.kind).toBe("type");
        expect(byName("Box")?.kind).toBe("class");
    });
});

describe("the skeleton command's filters and rendering", () => {
    it("--exported keeps the members of an exported class and drops those of a private one", () => {
        const source = parseSource(
            "owners.ts",
            `export class Shown {\n    visible(): void {}\n}\nclass Hidden {\n    secret(): void {}\n}\n`
        );
        const names = exportedOnly(extractSkeleton(source)).map((symbol) => symbol.name);

        expect(names).toEqual(["Shown", "visible"]);
    });

    it("does not tag the kind again after several leading modifiers", () => {
        const [symbol] = extractSkeleton(parseSource("base.ts", "export abstract class Base {}\n"));

        if (!symbol) {
            throw new Error("expected one declaration");
        }

        expect(stripAnsi(renderSymbol(symbol))).toContain("export abstract class Base");
        expect(stripAnsi(renderSymbol(symbol))).not.toContain("class export");
    });

    it.skipIf(process.getuid?.() === 0)("skips a directory it cannot read instead of aborting the walk", () => {
        write("walk/ok.ts", "export const a = 1;\n");
        write("walk/locked/hidden.ts", "export const b = 2;\n");
        chmodSync(join(root, "walk/locked"), 0o000);

        try {
            expect(collectFiles(join(root, "walk"))).toEqual([join(root, "walk/ok.ts")]);
        } finally {
            chmodSync(join(root, "walk/locked"), 0o755);
        }
    });

    it("expands a quoted glob, keeps sources only, and never reads an existing path as a pattern", () => {
        write("glob/repos.ts", "export const a = 1;\n");
        write("glob/repos-cache.ts", "export const b = 2;\n");
        write("glob/repos.test.ts", "export const c = 3;\n");
        write("glob/other.ts", "export const d = 4;\n");
        write("glob/[x].ts", "export const e = 5;\n");

        expect(collectFiles(join(root, "glob/repos*.ts"))).toEqual([
            join(root, "glob/repos-cache.ts"),
            join(root, "glob/repos.ts"),
        ]);
        expect(collectFiles(join(root, "glob/[x].ts"))).toEqual([join(root, "glob/[x].ts")]);
        expect(collectFiles(join(root, "glob/none*.ts"))).toEqual([]);
    });

    it("applies --ignore to a glob's matches below its literal folders, also outside the cwd", () => {
        write("glob-ignore/keep.ts", "export const a = 1;\n");
        write("glob-ignore/out.ts", "export const b = 2;\n");

        expect(collectFiles(join(root, "glob-ignore/*.ts"), { ignore: ["out"] })).toEqual([
            join(root, "glob-ignore/keep.ts"),
        ]);
        // A needle that names a folder above the matches skips nothing, as for a named directory.
        expect(collectFiles(join(root, "glob-ignore/*.ts"), { ignore: ["glob-ignore"] })).toHaveLength(2);
    });

    it("keeps a glob's matches inside the cwd when the needle names a folder above them", () => {
        write("glob-cwd/keep.ts", "export const a = 1;\n");
        write("glob-cwd/out.ts", "export const b = 2;\n");
        const previous = process.cwd();
        process.chdir(root);

        try {
            expect(collectFiles("glob-cwd/*.ts", { ignore: ["glob-cwd"] })).toEqual([
                join(root, "glob-cwd/keep.ts"),
                join(root, "glob-cwd/out.ts"),
            ]);
            expect(collectFiles("glob-cwd/*.ts", { ignore: ["out"] })).toEqual([join(root, "glob-cwd/keep.ts")]);
        } finally {
            process.chdir(previous);
        }
    });
});

describe("an exported const that is really an API", () => {
    // `ui`, `logger`, `out` and `SafeJSON` are all object literals bound to a const. The
    // declaration head alone collapsed the whole surface into one truncated line, so
    // `ui.raw` and `ui.err` were invisible and the file had to be opened to find them.
    const source = `export const ui = {
    ok(msg: string): void {
        write(msg);
    },
    kv(key: string, value: string, keyWidth = 9): void {
        write(key);
    },
    get level(): string {
        return "info";
    },
    raw: (msg: string): void => write(msg),
    prefix: "gt",
    nested: {
        deep(): void {},
    },
};

export const KEYS = ["a", "b"] as const;
`;

    const symbols = extractSkeleton(parseSource("ui.ts", source));
    const byName = (name: string) => symbols.find((symbol) => symbol.name === name);

    it("lists every member of the object, with its signature", () => {
        expect(byName("ok")?.kind).toBe("method");
        expect(byName("ok")?.signature).toBe("ok(msg: string): void");
        expect(byName("kv")?.signature).toBe("kv(key: string, value: string, keyWidth = 9): void");
        expect(byName("level")?.kind).toBe("getter");
        expect(byName("raw")?.kind).toBe("method");
        expect(byName("prefix")?.kind).toBe("field");
    });

    it("nests a nested object one level deeper", () => {
        expect(byName("nested")?.depth).toBe(1);
        expect(byName("deep")?.depth).toBe(2);
    });

    it("does not leave the declaration head ending in a bare `=`", () => {
        expect(byName("ui")?.signature).toBe("export const ui");
    });

    it("unwraps a parenthesized object literal", () => {
        const wrapped = extractSkeleton(parseSource("paren.ts", "export const api = ({ raw(): void {} });"));

        expect(wrapped.find((symbol) => symbol.name === "raw")?.kind).toBe("method");
    });

    it("leaves a non-object const as one line", () => {
        expect(byName("KEYS")?.kind).toBe("const");
        expect(symbols.filter((symbol) => symbol.name === "a")).toEqual([]);
    });
});

describe("expandTypes", () => {
    it("names the types a signature mentions and skips structural builtins", () => {
        const source = parseSource(
            "demo.ts",
            `import type { Account } from "./account";
export interface Local { id: string }
export function load(account: Account, cache: Map<string, Local>): Promise<Local[]> {
    const ignored: Local = cache.get("x") as Local;
    return Promise.resolve([ignored]);
}
`
        );

        const names = collectTypeNames(source);
        expect(names).toContain("Account");
        expect(names).toContain("Local");
        expect(names).not.toContain("Map");
        expect(names).not.toContain("Promise");
    });

    it("resolves a same-file declaration and follows a relative import", () => {
        write(
            "types/account.ts",
            `export interface Account {
    id: string;
    label?: string;
}
`
        );
        const entry = write(
            "types/entry.ts",
            `import type { Account } from "./account";
export interface Local {
    ok: boolean;
}
export function load(account: Account): Local {
    return { ok: Boolean(account) };
}
`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const expanded = expandTypes(source, entry, collectTypeNames(source), root);
        const byName = (name: string) => expanded.find((type) => type.name === name);

        expect(byName("Local")?.file).toBe(entry);
        expect(byName("Account")?.file).toBe(join(root, "types/account.ts"));
        expect(byName("Account")?.text).toContain("label?: string;");
        expect(byName("Account")?.truncated).toBe(false);
    });

    it("keeps two same-named types from different files instead of collapsing them", () => {
        // A bare-name dedupe key made the first `Options` suppress the second, so a signature
        // naming both printed one declaration and silently dropped the other.
        write(
            "types/reader.ts",
            `export interface Options {
    readerOnly: string;
}
`
        );
        write(
            "types/writer.ts",
            `interface Options {
    writerOnly: number;
}
export interface Result {
    opts: Options;
}
`
        );
        const entry = write(
            "types/both.ts",
            `import type { Options } from "./reader";
import type { Result } from "./writer";
export function run(a: Options, b: Result): void {
    void a;
    void b;
}
`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const expanded = expandTypes(source, entry, collectTypeNames(source), root);
        const bodies = expanded.map((type) => type.text).join("\n");

        expect(bodies).toContain("readerOnly");
        expect(bodies).toContain("writerOnly");
    });

    it("prints a type reached through two importers once", () => {
        write("twice/shared.ts", `export interface Shared {\n    once: boolean;\n}\n`);
        write(
            "twice/holder.ts",
            `import type { Shared } from "./shared";\nexport interface Holder {\n    shared: Shared;\n}\n`
        );
        const entry = write(
            "twice/entry.ts",
            `import type { Shared } from "./shared";\nimport type { Holder } from "./holder";\nexport function use(a: Shared, b: Holder): void {}\n`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const expanded = expandTypes(source, entry, collectTypeNames(source), root);

        expect(expanded.filter((type) => type.name === "Shared")).toHaveLength(1);
        expect(expanded.map((type) => type.name)).toContain("Holder");
    });

    it("follows an extends base and names a package it cannot open", () => {
        write(
            "deep/base.ts",
            `export interface Inner {\n    deep: boolean;\n}\nexport interface Base {\n    id: string;\n    inner: Inner;\n}\n`
        );
        const entry = write(
            "deep/entry.ts",
            `import type { Base } from "./base";\nimport type { Far } from "some-package";\nexport interface Near extends Base {\n    far: Far;\n}\nexport function take(near: Near): void {}\n`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const expanded = expandTypes(source, entry, collectTypeNames(source), root);
        const byName = (name: string) => expanded.find((type) => type.name === name);

        expect(byName("Base")?.text).toContain("id: string;");
        expect(byName("Base")?.depth).toBe(1);
        expect(byName("Inner")?.depth).toBe(2);
        expect(byName("Inner")?.text).toContain("deep: boolean;");
        expect(byName("Far")?.external).toBe("some-package");
    });

    it("follows a typeof alias to the value it names", () => {
        const entry = write(
            "alias/entry.ts",
            `export const shape = { a: 1 };\nexport type Shape = typeof shape;\nexport function use(s: Shape): void {}\n`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const expanded = expandTypes(source, entry, collectTypeNames(source), root);

        expect(expanded.find((type) => type.name === "shape")?.text).toContain("a: 1");
    });

    it("resolves an alias from the nearest workspace tsconfig, not only the root one", () => {
        write("ws/tsconfig.json", SafeJSON.stringify({ compilerOptions: { paths: { "@ws/*": ["src/*"] } } }));
        write("ws/src/thing.ts", "export interface Thing {\n    size: number;\n}\n");
        const entry = write(
            "ws/app/entry.ts",
            `import type { Thing } from "@ws/thing";\nexport function use(t: Thing): void {}\n`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const thing = expandTypes(source, entry, collectTypeNames(source), root).find((type) => type.name === "Thing");

        expect(thing?.file).toBe(join(root, "ws/src/thing.ts"));
        expect(thing?.text).toContain("size: number;");
    });

    it("follows a renamed import to the name the target file declares", () => {
        write("renamed/account.ts", "export interface Account {\n    handle: string;\n}\n");
        const entry = write(
            "renamed/entry.ts",
            `import type { Account as User } from "./account";\nexport function greet(user: User): void {}\n`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const expanded = expandTypes(source, entry, collectTypeNames(source), root);
        const user = expanded.find((type) => type.name === "User");

        expect(user?.file).toBe(join(root, "renamed/account.ts"));
        expect(user?.text).toContain("handle: string;");
    });

    it("keeps two same-named types from two files apart", () => {
        write(
            "twin/other.ts",
            `export interface Options {\n    remote: string;\n}\nexport interface Config {\n    options: Options;\n}\n`
        );
        const entry = write(
            "twin/entry.ts",
            `import type { Config } from "./other";\nexport interface Options {\n    local: boolean;\n}\nexport function run(options: Options, config: Config): void {}\n`
        );

        const source = parseSource(entry, readFileSync(entry, "utf8"));
        const options = expandTypes(source, entry, collectTypeNames(source), root).filter(
            (type) => type.name === "Options"
        );

        expect(options.map((type) => type.file).sort()).toEqual([entry, join(root, "twin/other.ts")].sort());
        expect(options.map((type) => type.text).join("\n")).toContain("remote: string;");
        expect(options.map((type) => type.text).join("\n")).toContain("local: boolean;");
    });

    it("returns nothing for a type it cannot resolve", () => {
        const source = parseSource(
            "demo.ts",
            `import type { Missing } from "./nowhere";
export function use(value: Missing): void {}
`
        );

        expect(expandTypes(source, join(root, "demo.ts"), collectTypeNames(source), root)).toEqual([]);
    });
});

describe("exportedOnly", () => {
    const of = (source: string) => exportedOnly(extractSkeleton(parseSource("f.ts", source)));

    // A literal carrying a method is expanded rather than inlined, which is what gives this
    // describe the parent-and-member pairs it needs.
    const shown = "export const shown = { one(): void {} };";
    const hidden = "const hidden = { two(): void {} };";

    it("keeps an exported declaration together with its own members", () => {
        const kept = of(`${shown}\n`);

        expect(kept.map((symbol) => symbol.name)).toEqual(["shown", "one"]);
    });

    it("drops a private declaration's members instead of re-parenting them", () => {
        // The bug this pins: filtering on `depth > 0` kept `two`, and because the list is flat
        // it then read as a second member of `shown`, whose span is line 1 alone.
        const kept = of(`${shown}\n${hidden}\n`);

        expect(kept.map((symbol) => symbol.name)).toEqual(["shown", "one"]);
        expect(kept.every((symbol) => symbol.startLine === 1)).toBe(true);
    });

    it("keeps nothing when the file exports nothing", () => {
        expect(of(`${hidden}\n`)).toEqual([]);
    });

    it("keeps a later export after a private one", () => {
        const kept = of(`${hidden}\nexport function shownFn(): void {}\n`);

        expect(kept.map((symbol) => symbol.name)).toEqual(["shownFn"]);
    });
});

describe("an object literal is inlined when it fits, expanded when it does not", () => {
    const of = (source: string) => extractSkeleton(parseSource("f.ts", source));

    it("inlines a short literal instead of spending a row per key", () => {
        const symbols = of('export const shown = { "k": 1, "v": 2 };\n');

        expect(symbols).toHaveLength(1);
        expect(symbols[0]?.signature).toBe('export const shown = { "k": 1, "v": 2 }');
    });

    it("drops a source trailing comma, which reads as damage on one line", () => {
        expect(of('export const shown = {\n    "k": 1,\n};\n')[0]?.signature).toBe('export const shown = { "k": 1 }');
    });

    it("expands plain data that is too long to fit on one line", () => {
        const wide = Array.from({ length: 12 }, (_, i) => `    keyNumber${i}: "value number ${i}",`).join("\n");
        const symbols = of(`export const table = {\n${wide}\n};\n`);

        expect(symbols).toHaveLength(13);
        expect(symbols[0]?.signature).toBe("export const table");
        expect(symbols[1]).toMatchObject({ kind: "field", depth: 1 });
    });

    it("expands a SHORT literal that carries a method, because that is an API", () => {
        // Size alone was the first rule and it inlined this, which stopped reporting `raw`.
        const symbols = of("export const api = ({ raw(): void {} });\n");

        expect(symbols.find((symbol) => symbol.name === "raw")?.kind).toBe("method");
    });

    it("inlines a nested literal too", () => {
        const symbols = of("export const outer = { a: 1, deep: { b: 2 } };\n");

        expect(symbols).toHaveLength(1);
        expect(symbols[0]?.signature).toContain("deep: { b: 2 }");
    });

    it("never inlines one declaration of a shared statement into another", () => {
        // The slice anchor is the STATEMENT, so `const a = {…}, b = {…}` would put `a`'s text
        // inside `b`'s signature. Such a statement is expanded instead.
        const symbols = of("const a = { x: 1 }, b = { y: 2 };\n");

        expect(symbols.filter((symbol) => symbol.depth === 0).map((symbol) => symbol.name)).toEqual(["a", "b"]);
        expect(symbols.every((symbol) => !symbol.signature.includes("y: 2") || symbol.name === "y")).toBe(true);
    });

    it("signs each declaration of a shared statement with its own text", () => {
        const heads = of("export const a = { x: 1 }, b = { y: 2 };\n").filter((symbol) => symbol.depth === 0);

        expect(heads.map((symbol) => symbol.signature)).toEqual(["export const a", "export const b"]);
    });

    it("keeps a wrapped callable as a method, so its object is not inlined as data", () => {
        const symbols = of("export const api = { run: (() => 1), stop: (() => 2) as () => number };\n");

        expect(symbols.find((symbol) => symbol.name === "run")?.kind).toBe("method");
        expect(symbols.find((symbol) => symbol.name === "stop")?.kind).toBe("method");
        expect(of("export const wrapped = (() => 1);\n")[0]?.kind).toBe("function");
    });
});

describe("renderSymbol", () => {
    const line = (source: string, index = 0) =>
        stripAnsi(renderSymbol(extractSkeleton(parseSource("f.ts", source))[index] as SkeletonSymbol));

    it("does not repeat a declaration keyword as a kind tag", () => {
        // An arrow-function const is kinded `function` while its keyword is `const`, which
        // used to render as "function export const fn = (x: number)".
        expect(line("export const fn = (x: number) => x + 1;\n")).toContain("export const fn = (x: number)");
        expect(line("export const fn = (x: number) => x + 1;\n")).not.toContain("function export const");
    });

    it("strips every leading modifier, not just the first", () => {
        // `export abstract class Base` left `abstract` as the opener, which is not a
        // declaration keyword, so the tag was printed and read "class export abstract class".
        expect(line("export abstract class Base {\n    id = 1;\n}\n")).not.toContain("class export abstract");
        expect(line("export async function load(): Promise<void> {\n    return;\n}\n")).not.toContain(
            "function export async"
        );
    });

    it("still tags a member, which carries no keyword of its own", () => {
        const wide = Array.from({ length: 12 }, (_, i) => `    keyNumber${i}: "value number ${i}",`).join("\n");

        expect(line(`export const facade = {\n${wide}\n};\n`, 1)).toContain("field keyNumber0");
    });
});

// Ported from the retired `tools repo-map`, whose ranking `tools ts skeleton --rank` now carries.
describe("rankFiles", () => {
    const now = 1_700_000_000_000;
    const base = { size: 1000, mtimeMs: now - 86_400_000 };
    const keyOf = (file: { path: string }) => file.path;

    it("ranks the file more files import first when size and recency are equal", () => {
        const ranked = rankFiles({
            files: [
                { path: "a", fanIn: 0, ...base },
                { path: "b", fanIn: 5, ...base },
            ],
            now,
            keyOf,
        });

        expect(ranked.map((file) => file.path)).toEqual(["b", "a"]);
    });

    it("ranks the more recently written file first when size and importers are equal", () => {
        const ranked = rankFiles({
            files: [
                { path: "old", fanIn: 0, size: 1000, mtimeMs: now - 30 * 86_400_000 },
                { path: "new", fanIn: 0, size: 1000, mtimeMs: now - 86_400_000 },
            ],
            now,
            keyOf,
        });

        expect(ranked[0].path).toBe("new");
    });

    it("breaks a tie by key so the order is stable", () => {
        const ranked = rankFiles({
            files: [
                { path: "b", fanIn: 1, ...base },
                { path: "a", fanIn: 1, ...base },
            ],
            now,
            keyOf,
        });

        expect(ranked.map((file) => file.path)).toEqual(["a", "b"]);
    });
});

describe("packByBudget", () => {
    const files = [
        { path: "a", rank: 0.9, tokens: 100 },
        { path: "b", rank: 0.5, tokens: 100 },
        { path: "c", rank: 0.1, tokens: 100 },
    ];

    it("keeps files in rank order until the budget is used, and never exceeds it", () => {
        const packed = packByBudget({ files, budget: 250 });

        expect(packed.included.map((file) => file.path)).toEqual(["a", "b"]);
        expect(packed.elided.map((file) => file.path)).toEqual(["c"]);
        expect(packed.usedTokens).toBe(200);
    });

    it("skips an over-budget high-rank file so a smaller one can still fit", () => {
        const packed = packByBudget({
            files: [
                { path: "big", rank: 0.9, tokens: 500 },
                { path: "small", rank: 0.5, tokens: 100 },
            ],
            budget: 200,
        });

        expect(packed.included.map((file) => file.path)).toEqual(["small"]);
        expect(packed.elided.map((file) => file.path)).toEqual(["big"]);
    });

    it("does not reorder its input", () => {
        const input = [...files];

        packByBudget({ files: input, budget: 100 });

        expect(input.map((file) => file.path)).toEqual(["a", "b", "c"]);
    });
});

describe("fanInOf", () => {
    const site = (specifier: string) => ({
        specifier,
        kind: "static" as const,
        typeOnly: false,
        names: [],
        locals: [],
        line: 1,
    });
    const moduleOf = (...specifiers: string[]) =>
        ({ imports: specifiers.map(site) }) as unknown as import("./types").ParsedModule;

    it("counts each importing file once, ignores itself and files outside the scan", () => {
        const files = [
            { file: "a.ts", absolute: "/r/a.ts" },
            { file: "b.ts", absolute: "/r/b.ts" },
            { file: "c.ts", absolute: "/r/c.ts" },
        ];
        const modules = new Map([
            ["a.ts", moduleOf("./c", "./c", "./a", "left-pad")],
            ["b.ts", moduleOf("./c", "./missing")],
            ["c.ts", moduleOf()],
        ]);
        const resolve = (specifier: string) =>
            ({ "./c": "/r/c.ts", "./a": "/r/a.ts", "./missing": "/elsewhere/x.ts" })[specifier];

        const fanIn = fanInOf({ files, modules, resolve });

        expect(fanIn.get("/r/c.ts")).toBe(2);
        expect(fanIn.get("/r/a.ts")).toBeUndefined();
        expect(fanIn.has("/elsewhere/x.ts")).toBe(false);
    });
});

function graphNode(label: string, kind: NodeKind = "file"): GraphNode {
    return { id: `/p/${label}`, path: `/p/${label}`, label, kind };
}

function graphEdge(from: GraphNode, to: GraphNode, line: number, site: Partial<ImportSite> = {}): GraphEdge {
    return {
        from: from.id,
        to: to.id,
        site: { specifier: to.label, kind: "static", typeOnly: false, names: [], locals: [], line, ...site },
    };
}

function graphOf(options: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    includeDynamic?: boolean;
    unresolved?: ImportGraph["unresolved"];
}): ImportGraph {
    const edges = new Map<string, GraphEdge[]>();

    for (const edge of options.edges) {
        edges.set(edge.from, [...(edges.get(edge.from) ?? []), edge]);
    }

    return {
        root: "/p",
        entry: options.nodes[0].id,
        includeDynamic: options.includeDynamic ?? false,
        nodes: new Map(options.nodes.map((node) => [node.id, node])),
        edges,
        unresolved: options.unresolved ?? [],
    };
}

function analyzed(label: string, overrides: Partial<AnalyzedModule> = {}): AnalyzedModule {
    return {
        id: `/p/${label}`,
        label,
        kind: "file",
        bytes: 100,
        selfMs: 1,
        totalMs: 1,
        descendants: 0,
        measured: true,
        findings: [],
        ...overrides,
    };
}

function analysisOf(modules: AnalyzedModule[], overrides: Partial<AnalysisResult> = {}): AnalysisResult {
    return {
        entry: modules[0].label,
        root: "/p",
        runs: 3,
        coldMs: 100,
        sumSelfMs: 95,
        modules,
        edges: [],
        unresolved: [],
        workerStderr: "",
        timedOut: false,
        unmeasured: 0,
        planned: modules.length,
        ...overrides,
    };
}

function findingOf(
    kind: Finding["kind"],
    severity: Finding["severity"],
    summary: string,
    details: string[] = []
): Finding {
    return { kind, severity, summary, details };
}

const RENDER_OPTIONS = { minMs: 0.5, depth: 4, top: 15, slowMs: 5 };

/**
 * entry.ts imports a.ts, b.ts, pkg:zod and tiny.ts; a.ts and b.ts both import c.ts, so c.ts is the shared
 * subtree. `moduleOverrides` changes one module without rebuilding the graph.
 */
function treeScenario(moduleOverrides: Record<string, Partial<AnalyzedModule>> = {}) {
    const entry = graphNode("entry.ts");
    const a = graphNode("a.ts");
    const b = graphNode("b.ts");
    const c = graphNode("c.ts");
    const zod = graphNode("pkg:zod", "package");
    const tiny = graphNode("tiny.ts");
    const graph = graphOf({
        nodes: [entry, a, b, c, zod, tiny],
        edges: [
            graphEdge(entry, a, 1),
            graphEdge(entry, b, 2),
            graphEdge(entry, zod, 3),
            graphEdge(entry, tiny, 4),
            graphEdge(a, c, 1),
            graphEdge(b, c, 1),
        ],
    });
    const base: Record<string, Partial<AnalyzedModule>> = {
        "entry.ts": { selfMs: 5, totalMs: 100, descendants: 5 },
        "a.ts": { selfMs: 20, totalMs: 60, descendants: 1 },
        "b.ts": { selfMs: 10, totalMs: 40, descendants: 1 },
        "c.ts": { selfMs: 15, totalMs: 15 },
        "pkg:zod": { selfMs: 8, totalMs: 8, kind: "package" },
        "tiny.ts": { selfMs: 0.1, totalMs: 0.1 },
    };
    const modules = Object.entries(base).map(([label, values]) =>
        analyzed(label, { ...values, ...moduleOverrides[label] })
    );

    return { graph, modules, result: analysisOf(modules, { sumSelfMs: 58.1 }) };
}

function treePart(text: string): string {
    return text.slice(text.indexOf("Import tree"), text.indexOf("Heaviest modules"));
}

describe("fmtMs", () => {
    it("keeps two decimals under 10 ms, one decimal under 100 ms and none above", () => {
        expect(fmtMs(0.5)).toBe("0.50 ms");
        expect(fmtMs(9.994)).toBe("9.99 ms");
        expect(fmtMs(10)).toBe("10.0 ms");
        expect(fmtMs(99.94)).toBe("99.9 ms");
        expect(fmtMs(100)).toBe("100 ms");
        expect(fmtMs(250.4)).toBe("250 ms");
    });
});

describe("renderAnalysis", () => {
    it("prints the cold import, the self-time sum, the module count and the run count under the entry", () => {
        const { graph, result } = treeScenario();
        const text = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));

        expect(text).toContain("tools ts imports analyze");
        expect(text).toContain("entry.ts");
        expect(text).toContain(
            "  cold import 100 ms   sum of self 58.1 ms   modules 6 (1 packages)   runs 3, min kept"
        );
    });

    it("draws the tree hottest child first and names a subtree it already expanded instead of repeating it", () => {
        const { graph, result } = treeScenario();
        const text = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));

        expect(treePart(text)).toMatch(
            /entry\.ts\s+total\s+100 ms\s+self\s+5\.00 ms\n├─ a\.ts\s+total\s+60\.0 ms\s+self\s+20\.0 ms\n│ {2}└─ c\.ts\s+total\s+15\.0 ms\s+self\s+15\.0 ms\n├─ b\.ts\s+total\s+40\.0 ms\s+self\s+10\.0 ms\n│ {2}└─ \(shared, shown above: c\.ts\)\n└─ pkg:zod\s+total\s+8\.00 ms\s+self\s+8\.00 ms\n/
        );
    });

    it("hides edges under --min-ms and says how many, and hides none at 0", () => {
        const { graph, result } = treeScenario();
        const hidden = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));
        const all = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, minMs: 0, graph }));

        expect(treePart(hidden)).not.toContain("tiny.ts");
        expect(hidden).toContain("1 edges below 0.50 ms hidden (--min-ms 0 shows all)");
        expect(treePart(all)).toContain("tiny.ts");
        expect(all).not.toContain("hidden (--min-ms 0 shows all)");
    });

    it("stops the tree at --depth", () => {
        const { graph, result } = treeScenario();
        const text = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, depth: 1, graph }));
        const tree = treePart(text);

        expect(tree).toContain("├─ a.ts");
        expect(tree).toContain("├─ b.ts");
        expect(tree).not.toContain("c.ts");
    });

    it("prints the tree of a run that measured no time at all", () => {
        const { graph, modules } = treeScenario();
        const text = captureOut(() =>
            renderAnalysis(analysisOf(modules, { coldMs: 0, sumSelfMs: 0 }), { ...RENDER_OPTIONS, graph })
        );

        expect(treePart(text)).toContain("├─ a.ts");
        expect(text).toContain("cold import 0.00 ms");
    });

    it("leaves out an edge whose target was never measured, even with --min-ms 0", () => {
        const entry = graphNode("entry.ts");
        const ghost = graphNode("ghost.ts");
        const graph = graphOf({ nodes: [entry, ghost], edges: [graphEdge(entry, ghost, 3)] });
        const text = captureOut(() =>
            renderAnalysis(analysisOf([analyzed("entry.ts", { totalMs: 5 })]), { ...RENDER_OPTIONS, minMs: 0, graph })
        );

        expect(treePart(text)).toContain("entry.ts");
        expect(treePart(text)).not.toContain("ghost.ts");
    });

    it("marks a module inside an import cycle and explains the mark", () => {
        const { graph, result } = treeScenario({
            "a.ts": { cycle: { size: 2, paidBy: "a.ts" } },
            "c.ts": { cycle: { size: 2, paidBy: "a.ts" } },
        });
        const text = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));

        expect(treePart(text)).toMatch(/├─ a\.ts ⇄ {2}total/);
        expect(treePart(text)).toMatch(/└─ c\.ts ⇄ {2}total/);
        expect(text).toContain("⇄ marks a module inside an import cycle");
        expect(text).toContain("(see `cycles`)");
    });

    it("prints no cycle legend when no module is in a cycle", () => {
        const { graph, result } = treeScenario();
        const text = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));

        expect(text).not.toContain("⇄");
    });

    it("shows why a module failed to import on its tree row", () => {
        const { graph, result } = treeScenario({ "b.ts": { importError: "Cannot find module 'left-pad'" } });
        const text = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));

        expect(treePart(text)).toMatch(/├─ b\.ts\s+total.*self.*Cannot find module 'left-pad'/);
    });

    it("lists dynamic imports that are not on the startup path, but not an awaited one", () => {
        const entry = graphNode("entry.ts");
        const lazy = graphNode("lazy.ts");
        const awaited = graphNode("awaited.ts");
        const graph = graphOf({
            nodes: [entry, lazy, awaited],
            edges: [
                graphEdge(entry, lazy, 9, { kind: "dynamic" }),
                graphEdge(entry, awaited, 10, { kind: "dynamic", awaited: true }),
            ],
        });
        const result = analysisOf([analyzed("entry.ts", { totalMs: 10 }), analyzed("awaited.ts"), analyzed("lazy.ts")]);
        const text = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));

        expect(text).toContain("Dynamic imports, not on the startup path (1)");
        expect(text).toContain("entry.ts:9 → lazy.ts");
        expect(text).not.toContain("entry.ts:10");
        expect(text).toContain("--include-dynamic walks and measures them too, marked (lazy) in the tree");
    });

    it("caps the dynamic import list at 12 and counts the rest", () => {
        const entry = graphNode("entry.ts");
        const targets = Array.from({ length: 14 }, (_, index) => graphNode(`lazy-${index}.ts`));
        const graph = graphOf({
            nodes: [entry, ...targets],
            edges: targets.map((target, index) => graphEdge(entry, target, index + 1, { kind: "dynamic" })),
        });
        const text = captureOut(() =>
            renderAnalysis(analysisOf([analyzed("entry.ts", { totalMs: 10 })]), { ...RENDER_OPTIONS, graph })
        );

        expect(text).toContain("Dynamic imports, not on the startup path (14)");
        expect(text).toContain("entry.ts:12 → lazy-11.ts");
        expect(text).not.toContain("lazy-12.ts");
        expect(text).toContain("+2 more");
    });

    it("walks a dynamic import and marks it (lazy) when dynamic imports are included", () => {
        const entry = graphNode("entry.ts");
        const lazy = graphNode("lazy.ts");
        const graph = graphOf({
            nodes: [entry, lazy],
            edges: [graphEdge(entry, lazy, 9, { kind: "dynamic" })],
            includeDynamic: true,
        });
        const modules = [
            analyzed("entry.ts", { totalMs: 40, selfMs: 5 }),
            analyzed("lazy.ts", { selfMs: 30, totalMs: 30 }),
        ];
        const text = captureOut(() =>
            renderAnalysis(analysisOf(modules, { coldMs: 100, sumSelfMs: 35 }), { ...RENDER_OPTIONS, graph })
        );

        expect(treePart(text)).toMatch(/└─ lazy\.ts \(lazy\)\s+total/);
        expect(text).toContain("sum of self (lazy included)");
        expect(text).not.toContain("Dynamic imports, not on the startup path");
        expect(text).not.toContain("cold and sum-of-self differ");
    });

    it("warns when the cold import and the self-time sum differ by more than 15%, and not for a small gap", () => {
        const { graph, result } = treeScenario();
        const far = captureOut(() => renderAnalysis(result, { ...RENDER_OPTIONS, graph }));
        const near = captureOut(() => renderAnalysis({ ...result, sumSelfMs: 90 }, { ...RENDER_OPTIONS, graph }));

        expect(far).toContain("cold and sum-of-self differ by more than 15%");
        expect(near).not.toContain("cold and sum-of-self differ");
    });

    it("lists the heaviest measured modules in order, capped at --top, with the kind of each", () => {
        const entry = graphNode("entry.ts");
        const graph = graphOf({ nodes: [entry], edges: [] });
        const modules = [
            analyzed("entry.ts", { selfMs: 40, totalMs: 90, descendants: 4 }),
            analyzed("pkg:zod", { kind: "package", selfMs: 30, totalMs: 30 }),
            analyzed("logo.svg", { kind: "asset", selfMs: 20, totalMs: 20 }),
            analyzed("node:fs", { kind: "builtin", selfMs: 10, totalMs: 10 }),
            analyzed("cut.ts", { selfMs: 5, totalMs: 5 }),
            analyzed("unmeasured.ts", { measured: false }),
        ];
        const text = captureOut(() => renderAnalysis(analysisOf(modules), { ...RENDER_OPTIONS, top: 4, graph }));
        const table = text.slice(text.indexOf("Heaviest modules by self time (top 4)"));

        expect(text).toContain("modules 5 (1 packages)");
        expect(table).toMatch(/entry\.ts\s+│\s+40\.0 ms\s+│\s+90\.0 ms\s+│\s+4\s+│\s+file\s+│/);
        expect(table).toMatch(/pkg:zod\s+│\s+30\.0 ms\s+│\s+30\.0 ms\s+│\s+0\s+│\s+pkg\s+│/);
        expect(table).toMatch(/logo\.svg\s+│.*│\s+asset\s+│/);
        expect(table).toMatch(/node:fs\s+│.*│\s+builtin\s+│/);
        expect(table).not.toContain("cut.ts");
        expect(table).not.toContain("unmeasured.ts");
    });

    it("cuts a module label longer than 58 characters in the table", () => {
        const label = `src/${"deeply-nested/".repeat(6)}module.ts`;
        const graph = graphOf({ nodes: [graphNode("entry.ts")], edges: [] });
        const text = captureOut(() =>
            renderAnalysis(analysisOf([analyzed("entry.ts"), analyzed(label, { selfMs: 5 })]), {
                ...RENDER_OPTIONS,
                graph,
            })
        );

        expect(label.length).toBeGreaterThan(58);
        expect(text).toContain(`${label.slice(0, 57)}…`);
    });

    it("gives each kind of finding its own short reason in the table", () => {
        const kinds: Array<[Finding["kind"], string]> = [
            ["native-addon", "native addon"],
            ["top-level-await", "top-level await"],
            ["side-effects", "module-scope work"],
            ["large-subtree", "7 modules under it"],
            ["barrel", "barrel"],
            ["exits-on-import", "exits on import"],
            ["import-error", "import failed"],
        ];
        const modules = [
            analyzed("entry.ts"),
            ...kinds.map(([kind], index) =>
                analyzed(`m${index}.ts`, {
                    descendants: 7,
                    findings: [findingOf(kind, "low", `summary ${kind}`)],
                })
            ),
        ];
        const graph = graphOf({ nodes: [graphNode("entry.ts")], edges: [] });
        const text = captureOut(() => renderAnalysis(analysisOf(modules), { ...RENDER_OPTIONS, graph }));

        kinds.forEach(([, reason], index) => {
            expect(text).toMatch(new RegExp(`m${index}\\.ts\\s+│.*│\\s+${reason}\\s+│`));
        });
    });

    it("tells the member that carried a cycle from the others, and counts further findings", () => {
        const modules = [
            analyzed("entry.ts"),
            analyzed("paid.ts", {
                cycle: { size: 2, paidBy: "paid.ts" },
                findings: [findingOf("cycle", "low", "cycle")],
            }),
            analyzed("member.ts", {
                cycle: { size: 2, paidBy: "paid.ts" },
                findings: [
                    findingOf("cycle", "low", "cycle"),
                    findingOf("barrel", "low", "barrel"),
                    findingOf("side-effects", "low", "work"),
                ],
            }),
            analyzed("clean.ts"),
        ];
        const graph = graphOf({ nodes: [graphNode("entry.ts")], edges: [] });
        const text = captureOut(() => renderAnalysis(analysisOf(modules), { ...RENDER_OPTIONS, graph }));

        expect(text).toMatch(/paid\.ts\s+│.*│\s+carries an import cycle\s+│/);
        expect(text).toMatch(/member\.ts\s+│.*│\s+in an import cycle \+2\s+│/);
        expect(text).toMatch(/clean\.ts\s+│.*│\s+—\s+│/);
    });

    it("explains the entry and every slow or serious module, and skips a cheap one with only a low finding", () => {
        const modules = [
            analyzed("entry.ts", {
                selfMs: 1,
                totalMs: 50,
                findings: [findingOf("large-subtree", "low", "entry pulls 9")],
            }),
            analyzed("slow.ts", {
                selfMs: 12,
                totalMs: 12,
                findings: [findingOf("side-effects", "low", "runs work at import", ["slow.ts:4 setInterval(...)"])],
            }),
            analyzed("serious.ts", {
                selfMs: 1,
                findings: [
                    findingOf("native-addon", "high", "loads a native addon"),
                    findingOf("top-level-await", "medium", "awaits at module scope"),
                ],
            }),
            analyzed("cheap.ts", { selfMs: 1, findings: [findingOf("barrel", "low", "cheap barrel finding")] }),
            analyzed("none.ts", { selfMs: 50 }),
        ];
        const graph = graphOf({ nodes: [graphNode("entry.ts")], edges: [] });
        const text = captureOut(() => renderAnalysis(analysisOf(modules), { ...RENDER_OPTIONS, graph }));
        const why = text.slice(text.indexOf("\n  Why\n"));

        expect(why).toContain("entry.ts  self 1.00 ms, total 50.0 ms");
        expect(why).toMatch(/● +entry pulls 9/);
        expect(why).toContain("slow.ts  self 12.0 ms, total 12.0 ms");
        expect(why).toMatch(/● +runs work at import/);
        expect(why).toContain("      slow.ts:4 setInterval(...)");
        expect(why).toMatch(/● +loads a native addon/);
        expect(why).toMatch(/● +awaits at module scope/);
        expect(why).not.toContain("cheap barrel finding");
        expect(why).not.toContain("none.ts");
    });

    it("has no Why section when no module has a finding worth a paragraph", () => {
        const graph = graphOf({ nodes: [graphNode("entry.ts")], edges: [] });
        const text = captureOut(() => renderAnalysis(analysisOf([analyzed("entry.ts")]), { ...RENDER_OPTIONS, graph }));

        expect(text).not.toContain("\n  Why\n");
    });

    it("lists the first 10 unresolved specifiers and the total", () => {
        const unresolved = Array.from({ length: 12 }, (_, index) => ({
            from: "entry.ts",
            specifier: `./missing-${index}`,
            line: index + 1,
        }));
        const graph = graphOf({ nodes: [graphNode("entry.ts")], edges: [], unresolved });
        const text = captureOut(() =>
            renderAnalysis(analysisOf([analyzed("entry.ts")], { unresolved }), { ...RENDER_OPTIONS, graph })
        );

        expect(text).toContain("Unresolved specifiers (12)");
        expect(text).toContain("entry.ts:10  ./missing-9");
        expect(text).not.toContain("./missing-10");
    });
});

describe("renderLazy", () => {
    const candidate = (overrides: Partial<LazyCandidate> = {}): LazyCandidate => ({
        importer: "src/cli.ts",
        line: 12,
        target: "src/heavy.ts",
        locals: ["heavy"],
        exclusiveModules: 6,
        savingMs: 18.4,
        caveats: [],
        ...overrides,
    });

    it("says nothing saves enough when every candidate is under --min-ms", () => {
        const text = captureOut(() => renderLazy([candidate({ savingMs: 0.2 })], "src/cli.ts", 0.5));

        expect(text).toContain("tools ts imports lazy");
        expect(text).toContain("no static import saves 0.50 ms or more when made lazy (--min-ms lowers the bar)");
        expect(text).not.toContain("IMPORTER");
    });

    it("lists each candidate with the line, target, saving and module count, and explains how to read it", () => {
        const text = captureOut(() => renderLazy([candidate()], "src/cli.ts", 0.5));

        expect(text).toMatch(/src\/cli\.ts\s+│\s+12\s+│\s+src\/heavy\.ts\s+│\s+18\.4 ms\s+│\s+6\s+│\s+—\s+│/);
        expect(text).toContain("How to read it");
        expect(text).toContain("`await import()` at the use site");
        expect(text).not.toContain("Caveats");
    });

    it("drops the candidates under --min-ms and keeps the rest", () => {
        const text = captureOut(() =>
            renderLazy(
                [candidate({ target: "src/big.ts" }), candidate({ target: "src/small.ts", savingMs: 0.1 })],
                "src/cli.ts",
                0.5
            )
        );

        expect(text).toContain("src/big.ts");
        expect(text).not.toContain("src/small.ts");
    });

    it("counts the caveats of a candidate and prints at most 3 per target for the first 5 targets", () => {
        const caveats = ["c1 timer", "c2 hook", "c3 assign", "c4 spawn"];
        const many = Array.from({ length: 6 }, (_, index) =>
            candidate({ target: `src/t${index}.ts`, caveats: index === 0 ? caveats : ["only"] })
        );
        const text = captureOut(() => renderLazy(many, "src/cli.ts", 0.5));
        const detail = text.slice(text.indexOf("\n  Caveats\n"));

        expect(text).toMatch(/src\/t0\.ts\s+│.*│\s+4 side effect\(s\)\s+│/);
        expect(detail).toContain("src/t0.ts");
        expect(detail).toContain("  c1 timer");
        expect(detail).toContain("  c3 assign");
        expect(detail).not.toContain("c4 spawn");
        expect(detail).toContain("src/t4.ts");
        expect(detail).not.toContain("src/t5.ts");
    });
});

describe("renderBarrels", () => {
    const waste = (overrides: Partial<BarrelWaste> = {}): BarrelWaste => ({
        importer: "src/app.ts",
        importerLine: 3,
        barrel: "src/utils/index.ts",
        used: ["join", "slug"],
        usedTargets: ["src/utils/path.ts"],
        unusedTargets: ["src/utils/ai.ts", "src/utils/db.ts"],
        wastedModules: 9,
        wastedMs: 31.2,
        ...overrides,
    });

    it("says no barrel wastes enough when all are under --min-ms", () => {
        const text = captureOut(() => renderBarrels([waste({ wastedMs: 0.1 })], "src/app.ts", 0.5));

        expect(text).toContain("tools ts imports barrels");
        expect(text).toContain("no barrel import wastes 0.50 ms or more on this startup path");
        expect(text).not.toContain("BARREL");
    });

    it("tabulates the names used against the targets available, with the time and modules wasted", () => {
        const text = captureOut(() => renderBarrels([waste()], "src/app.ts", 0.5));

        expect(text).toMatch(
            /src\/app\.ts\s+│\s+3\s+│\s+src\/utils\/index\.ts\s+│\s+1\s+│\s+3\s+│\s+31\.2 ms\s+│\s+9\s+│/
        );
        expect(text).toContain("src/app.ts:3 imports {join, slug} from src/utils/index.ts");
        expect(text).toContain("needs  src/utils/path.ts");
        expect(text).toContain("drags  src/utils/ai.ts, src/utils/db.ts");
    });

    it("names the barrel's own code as the need when no re-export target is used, and counts dragged targets past 6", () => {
        const unusedTargets = Array.from({ length: 8 }, (_, index) => `u${index}.ts`);
        const text = captureOut(() => renderBarrels([waste({ usedTargets: [], unusedTargets })], "src/app.ts", 0.5));

        expect(text).toContain("needs  (the barrel's own code)");
        expect(text).toContain("drags  u0.ts, u1.ts, u2.ts, u3.ts, u4.ts, u5.ts +2");
        expect(text).not.toContain("u6.ts");
    });

    it("prints the detail of only the first 8 barrel imports", () => {
        const many = Array.from({ length: 10 }, (_, index) => waste({ importer: `src/i${index}.ts` }));
        const detail = captureOut(() => renderBarrels(many, "src/app.ts", 0.5));
        const lines = detail.slice(detail.indexOf("\n  Detail\n"));

        expect(lines).toContain("src/i7.ts:3 imports");
        expect(lines).not.toContain("src/i8.ts:3 imports");
    });
});

describe("renderCycles", () => {
    const cycle = (overrides: Partial<ImportCycle> = {}): ImportCycle => ({
        memberIds: ["/p/x.ts", "/p/y.ts"],
        members: ["x.ts", "y.ts"],
        edges: [
            { from: "x.ts", to: "y.ts", line: 2 },
            { from: "y.ts", to: "x.ts", line: 5 },
        ],
        selfMs: 12.5,
        ...overrides,
    });

    it("reports a startup path with no cycle", () => {
        const text = captureOut(() => renderCycles([], "entry.ts"));

        expect(text).toContain("tools ts imports cycles");
        expect(text).toContain("no import cycles on the startup path");
        expect(text).not.toContain("MEMBERS");
    });

    it("lists each cycle with its size, self time and members, then the edges that close it", () => {
        const text = captureOut(() => renderCycles([cycle()], "entry.ts"));

        expect(text).toMatch(/2\s+│\s+12\.5 ms\s+│\s+x\.ts ⇄ y\.ts\s+│/);
        expect(text).toContain("2 modules");
        expect(text).toContain("  x.ts:2 → y.ts");
        expect(text).toContain("  y.ts:5 → x.ts");
    });

    it("cuts a long member list at 90 characters, shows 12 edges per cycle and 10 cycles", () => {
        const members = Array.from({ length: 30 }, (_, index) => `module-${index}.ts`);
        const edges = Array.from({ length: 14 }, (_, index) => ({ from: `e${index}.ts`, to: "t.ts", line: index }));
        const cycles = Array.from({ length: 11 }, (_, index) =>
            cycle({ members: index === 0 ? members : [`a${index}.ts`, `b${index}.ts`], edges })
        );
        const text = captureOut(() => renderCycles(cycles, "entry.ts"));

        expect(text).toContain(`${members.join(" ⇄ ").slice(0, 89)}…`);
        expect(text).toContain("  e11.ts:11 → t.ts");
        expect(text).not.toContain("e12.ts");
        expect(text.match(/ modules\n/g)).toHaveLength(10);
    });
});
