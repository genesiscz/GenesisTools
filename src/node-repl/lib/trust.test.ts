import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_IMPORT_POLICY, type ImportPolicy, importAllowed, loadImportPolicy } from "./trust";

function policy(overrides: Partial<ImportPolicy> = {}): ImportPolicy {
    return { ...DEFAULT_IMPORT_POLICY, ...overrides };
}

/**
 * A directory holding one resolvable package, the shape js_add_node_module_dir registers.
 * Built once: every case reads it and none mutates it, and the CI suite runs against a
 * wall-clock budget that per-test temp trees eat into for no added coverage.
 */
function buildModuleDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "node-repl-trust-"));
    mkdirSync(join(dir, "node_modules", "fakepkg"), { recursive: true });
    writeFileSync(
        join(dir, "node_modules", "fakepkg", "package.json"),
        SafeJSON.stringify({ name: "fakepkg", main: "index.js" })
    );
    writeFileSync(join(dir, "node_modules", "fakepkg", "index.js"), "module.exports = {};");
    return dir;
}

const MODULE_DIR = buildModuleDir();

function policyFile(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "node-repl-policy-")), "trust.json");
    writeFileSync(path, contents);
    return path;
}

describe("importAllowed", () => {
    const closed = policy({ allowRepoDeps: false, allowPaths: false, allowBuiltins: false });

    it("allows a bare specifier the registered directory actually supplies", () => {
        expect(importAllowed("fakepkg", closed, [MODULE_DIR]).allowed).toBe(true);
    });

    // The whole point of the gate: registering one directory must not become "allow everything".
    it("still refuses a bare specifier that directory does not supply", () => {
        expect(importAllowed("some-unrelated-package", closed, [MODULE_DIR]).allowed).toBe(false);
    });

    // The check and the import must be about the SAME file. Handing back the resolved path is
    // what stops the worker re-resolving the specifier and loading a different module.
    it("returns the exact path the containment check approved", () => {
        const decision = importAllowed("fakepkg", closed, [MODULE_DIR]);
        expect(decision.allowed).toBe(true);
        expect(decision.resolved).toBeDefined();
        expect(decision.resolved).toContain("fakepkg");
        expect(decision.resolved?.endsWith("index.js")).toBe(true);
    });

    it("carries no path for specifiers a directory did not authorize", () => {
        expect(importAllowed("node:path", policy({ allowBuiltins: true }), []).resolved).toBeUndefined();
        expect(importAllowed("picocolors", policy({ allowRepoDeps: true }), []).resolved).toBeUndefined();
    });

    it("keeps the builtin, path and repo-dep rules independent of the directory list", () => {
        const dirs = [MODULE_DIR];
        expect(importAllowed("node:path", closed, dirs).allowed).toBe(false);
        expect(importAllowed("node:path", policy({ allowBuiltins: true }), dirs).allowed).toBe(true);
        expect(importAllowed("/tmp/x.js", closed, dirs).allowed).toBe(false);
        expect(importAllowed("picocolors", closed, dirs).allowed).toBe(false);
        expect(importAllowed("picocolors", policy({ allowRepoDeps: true }), dirs).allowed).toBe(true);
    });

    // Bun resolves `fs` and `node:fs` to the same module, so gating only the prefixed spelling
    // left every builtin reachable through allowRepoDeps while allowBuiltins read false.
    it("applies allowBuiltins to the bare spelling of a builtin, not just the node: prefix", () => {
        const noBuiltins = policy({ allowBuiltins: false, allowRepoDeps: true });
        expect(importAllowed("node:fs", noBuiltins, []).allowed).toBe(false);
        expect(importAllowed("fs", noBuiltins, []).allowed).toBe(false);
        expect(importAllowed("path", noBuiltins, []).allowed).toBe(false);
        // Subpaths are the same class and were the shape this assertion originally missed.
        expect(importAllowed("fs/promises", noBuiltins, []).allowed).toBe(false);
        expect(importAllowed("node:fs/promises", noBuiltins, []).allowed).toBe(false);
        expect(importAllowed("stream/web", noBuiltins, []).allowed).toBe(false);

        const withBuiltins = policy({ allowBuiltins: true, allowRepoDeps: false });
        expect(importAllowed("fs", withBuiltins, []).allowed).toBe(true);
        expect(importAllowed("node:fs", withBuiltins, []).allowed).toBe(true);
    });

    it("honours an exact allowBare entry without substring matching", () => {
        const named = policy({ allowRepoDeps: false, allowBare: ["lodash"] });
        expect(importAllowed("lodash", named, []).allowed).toBe(true);
        expect(importAllowed("lodash-es", named, []).allowed).toBe(false);
    });
});

describe("loadImportPolicy", () => {
    it("returns the built-in defaults when no file exists", () => {
        expect(loadImportPolicy(join(tmpdir(), "node-repl-absent", "trust.json"))).toEqual(DEFAULT_IMPORT_POLICY);
    });

    it("reads a well-formed policy", () => {
        const path = policyFile(SafeJSON.stringify({ allowPaths: false, allowBare: ["lodash"] }));
        const loaded = loadImportPolicy(path);
        expect(loaded.allowPaths).toBe(false);
        expect(loaded.allowBare).toEqual(["lodash"]);
        expect(loaded.source).toBe(path);
    });

    // "false" is truthy, so an unvalidated policy would widen the gate instead of closing it.
    it("refuses a boolean field written as a string", () => {
        expect(() => loadImportPolicy(policyFile(SafeJSON.stringify({ allowPaths: "false" })))).toThrow("allowPaths");
    });

    it("refuses an allowBare that is not a list of specifier strings", () => {
        expect(() => loadImportPolicy(policyFile(SafeJSON.stringify({ allowBare: "lodash" })))).toThrow("allowBare");
        expect(() => loadImportPolicy(policyFile(SafeJSON.stringify({ allowBare: [1] })))).toThrow("allowBare");
    });

    it("refuses a policy that is not an object", () => {
        expect(() => loadImportPolicy(policyFile("[]"))).toThrow("JSON object");
    });
});
