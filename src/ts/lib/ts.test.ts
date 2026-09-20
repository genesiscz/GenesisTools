import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILER_SCOPE_NAMES } from "@genesiscz/utils/profile";
import { parsePositive, resolveEntries } from "../commands/imports";
import { computeTotals } from "./analyze";
import { attribute, isBarrel, nativeSignals } from "./attribute";
import { findBarrelWaste } from "./barrels";
import { findCycles } from "./cycles";
import { buildGraph, isLoadTimeEdge, isMeasuredEdge, labelFor, packageNameOf, postOrder, reachableFrom } from "./graph";
import { findLazyCandidates } from "./lazy";
import type { WorkerSample } from "./measure";
import { parseModule } from "./parse";
import { extractSkeleton, parseSource } from "./skeleton";
import { collectTypeNames, expandTypes } from "./type-expand";

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
