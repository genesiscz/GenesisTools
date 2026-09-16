import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEntries } from "../commands/imports";
import { computeTotals } from "./analyze";
import { attribute, isBarrel, nativeSignals } from "./attribute";
import { findBarrelWaste } from "./barrels";
import { findCycles } from "./cycles";
import { buildGraph, labelFor, packageNameOf, postOrder, reachableFrom } from "./graph";
import { findLazyCandidates } from "./lazy";
import type { WorkerSample } from "./measure";
import { parseModule } from "./parse";

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
            'import { a, b, c, d } from "./m";\nconst v = a.x;\nfunction f() { return b(); }\nexport { c };\nclass K { static { d(); } m() { b(); } }',
            "probe.ts"
        );
        expect([...parsed.moduleScopeUses].sort()).toEqual(["a", "c", "d"]);
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

    it("records re-exports, declared export names and dynamic imports", () => {
        const parsed = parseModule(
            'export * from "./x";\nexport { y as yy } from "./y";\nexport const { p, q } = obj;\nexport function f() {}\nexport default f;\nconst m = () => import("./lazy");\nconst r = require("./cjs");',
            "probe.ts"
        );
        expect(parsed.reexports.map((site) => site.names)).toEqual([["*"], ["y"]]);
        expect([...parsed.exportNames].sort()).toEqual(["default", "f", "p", "q"]);
        expect(parsed.imports.find((site) => site.specifier === "./lazy")?.kind).toBe("dynamic");
        expect(parsed.imports.find((site) => site.specifier === "./cjs")?.kind).toBe("require");
        expect(parsed.localExports).toBe(2);
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

    it("follows dynamic imports when asked", () => {
        const graph = buildGraph({ entry: join(root, "entry.ts"), root, includeDynamic: true });
        expect(reachableFrom(graph, join(root, "entry.ts")).has(join(root, "dyn.ts"))).toBe(true);
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
        expect(cycles[0].selfMs).toBe(4);
        expect(cycles[0].edges).toHaveLength(2);
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
