import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { CANARY_PACKAGES, lockStamp, STAMP_FILE } from "../test-deps";
import { checkProjects, installStamp, ScratchTree, testFolders } from "./layer-cut";
import { loadTable } from "./layer-cut-tables/load";
import unified from "./layer-cut-tables/unified";

const fixtureRoots: string[] = [];

function fixtureRoot(label: string): string {
    const root = mkdtempSync(join(tmpdir(), `layer-cut-${label}-`));
    fixtureRoots.push(root);
    return root;
}

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

test("default table and explicit unified module preserve the same cut", async () => {
    expect(await loadTable([])).toBe(unified);
    expect(await loadTable(["--table", `${import.meta.dir}/layer-cut-tables/unified.ts`])).toBe(unified);
});

test("--table selects a complete alternate cut without changing the default", async () => {
    const table = await loadTable(["--table", `${import.meta.dir}/layer-cut-tables/722.ts`]);
    expect(table.selection).toBe("diff");
    expect(table.branches).toHaveLength(7);
    expect(table.defaults.base).toBe("origin/feat/2026-11-03-ai-usage-6-review-followups");
    expect(table.refPrefix).toBe("refs/heads/cut/722/");
    expect(await loadTable([])).toBe(unified);
});

test("test discovery uses the checked tree even when the source no longer has its tests", () => {
    const entry = { mode: "100644", sha: "fixture" };
    const checked = new Map([
        ["src/widget/index.ts", entry],
        ["src/widget/index.test.ts", entry],
    ]);
    expect(testFolders(["src/widget/index.ts"], checked)).toEqual(["src/widget"]);
    expect(testFolders(["src/widget/index.ts"], new Map())).toEqual([]);
});

test("project discovery includes mobile configs for selected mobile files", () => {
    const entry = { mode: "100644", sha: "fixture" };
    const tree = new Map(
        ["tsconfig.json", "DevDashboard/mobile/tsconfig.json", "DevDashboard/mobile/package.json"].map((file) => [
            file,
            entry,
        ])
    );
    expect(checkProjects(["DevDashboard/mobile/src/screen.tsx"], tree)).toEqual([
        "DevDashboard/mobile/tsconfig.json",
        "tsconfig.json",
    ]);
    expect(checkProjects(["src/widget/index.ts"], tree)).toEqual(["tsconfig.json"]);
});

test("install invalidation covers workspace manifests and standalone project locks", () => {
    const entry = { mode: "100644", sha: "before" };
    const tree = new Map(
        ["bun.lock", "src/utils/package.json", "DevDashboard/mobile/package.json", "DevDashboard/mobile/bun.lock"].map(
            (file) => [file, entry]
        )
    );
    const initial = installStamp(tree);
    for (const file of [...tree.keys()].filter((file) => file !== "bun.lock")) {
        tree.set(file, { ...entry, sha: "after" });
        expect(installStamp(tree)).not.toBe(initial);
        tree.set(file, entry);
    }
    tree.set("src/tool/index.ts", entry);
    expect(installStamp(tree)).toBe(initial);
});

test("cut preserves foreign refs and checks recorded tests without resolving a moving source", async () => {
    const script = join(import.meta.dir, "layer-cut.ts");
    const root = fixtureRoot("cut");
    const invoke = (cmd: string[], cwd = root) => {
        const result = Bun.spawnSync(cmd, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return result.stdout.toString().trim();
    };
    const git = (...args: string[]) => invoke(["git", ...args]);
    git("init");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "alice@example.com");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    mkdirSync(join(root, "fixtures/canary"), { recursive: true });
    writeFileSync(join(root, "fixtures/canary/package.json"), SafeJSON.stringify({ name: "fixture-dep", version: "1.0.0" }));
    writeFileSync(
        join(root, "package.json"),
        SafeJSON.stringify({
            name: "fixture",
            dependencies: Object.fromEntries(CANARY_PACKAGES.map((name) => [name, "file:fixtures/canary"])),
            scripts: { prepare: "git config layercut.prepare ran" },
        })
    );
    invoke(["bun", "install", "--ignore-scripts"]);
    mkdirSync(join(root, "apps/eve"), { recursive: true });
    writeFileSync(join(root, "apps/eve/package.json"), SafeJSON.stringify({
        name: "fixture-subproject", dependencies: { "fixture-dep": "file:../../fixtures/canary" },
        scripts: { prepare: "git config layercut.subprepare ran" },
    }));
    invoke(["bun", "install", "--ignore-scripts"], join(root, "apps/eve"));
    mkdirSync(join(root, "scripts"));
    for (const file of ["test.ts", "test-args.ts", "test-deps.ts", "test-reap.ts"]) {
        writeFileSync(join(root, "scripts", file), readFileSync(join(import.meta.dir, "..", file)));
    }
    mkdirSync(join(root, "src/utils/process"), { recursive: true });
    writeFileSync(join(root, "src/utils/process/process-basics.ts"), readFileSync(join(import.meta.dir, "../../src/utils/process/process-basics.ts")));
    git("add", "package.json", ".gitignore", "fixtures", "apps", "scripts", "src/utils/process");
    // Bun can omit a lock for a package with no dependencies.
    if (existsSync(join(root, "bun.lock"))) {
        git("add", "bun.lock");
    }
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(root, "src/widget"), { recursive: true });
    writeFileSync(join(root, "src/widget/index.ts"), "export const widget = 1;\n");
    const proof = join(root, "tests-ran");
    writeFileSync(join(root, "src/widget/index.test.ts"),
        `import { test } from "bun:test"; test("fixture", async () => { await Bun.write(${SafeJSON.stringify(proof)}, "src/widget"); });`);
    git("add", "src/widget/index.ts", "src/widget/index.test.ts", "scripts/test.ts");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture source");
    const source = git("rev-parse", "HEAD");
    git("update-ref", "refs/heads/cut/feat/foreign-table", base);
    const configBefore = git("config", "--local", "--list");
    const tableFile = join(root, "table.ts");
    writeFileSync(
        tableFile,
        `export default ${SafeJSON.stringify({
            branches: [
                {
                    name: "feat/fixture",
                    parent: null,
                    subject: "feat(tools): fixture cut",
                    scopes: [],
                    globs: ["**"],
                    sweep: ["src/**", "scripts/**"],
                },
            ],
            keepAtBase: {},
            defaults: { unified: source, unifiedBranch: "fixture", base },
            selection: "diff",
            refPrefix: "refs/heads/cut/",
        })};`
    );
    const scratch = join(root, "scratch");
    invoke(["bun", script, "--table", tableFile, "--scratch", scratch, "--no-typecheck"]);
    expect(git("rev-parse", "refs/heads/cut/feat/foreign-table")).toBe(base);
    invoke([
        "bun",
        script,
        "--table",
        tableFile,
        "--scratch",
        scratch,
        "--checks-only",
        "--tests",
        "--unified",
        "missing-moving-source",
    ]);
    expect(readFileSync(proof, "utf8")).toBe("src/widget");
    expect(git("config", "--local", "--list")).toBe(configBefore);
    const checked = join(scratch, "tree");
    expect(readFileSync(join(checked, "node_modules", STAMP_FILE), "utf8")).toBe(lockStamp(checked));
    // Force root repair as well as the subproject repair exercised above.
    writeFileSync(join(checked, "node_modules", STAMP_FILE), "stale");
    invoke(["bun", "scripts/test.ts", "src/widget"], checked);
    expect(git("config", "--local", "--list")).not.toBe(configBefore);
    const checks = SafeJSON.parse(readFileSync(join(scratch, "checks.json"), "utf8"));
    expect(checks.tests["feat/fixture"].folders).toEqual(["src/widget"]);
});

test("--table requires a module path", async () => {
    await expect(loadTable(["--table"])).rejects.toThrow("requires a path");
    await expect(loadTable(["--table", "--tests"])).rejects.toThrow("requires a path");
});

test("scratch reuse refuses developer checkouts and dirty owned trees", async () => {
    const original = process.cwd();
    const root = fixtureRoot("ownership");
    const git = (args: string[], cwd = root): string => {
        const result = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString().trim();
    };
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "alice@example.com"]);
    writeFileSync(join(root, "tracked.txt"), "original");
    git(["add", "tracked.txt"]);
    git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
    const sha = git(["rev-parse", "HEAD"]);
    try {
        process.chdir(root);
        const developer = new ScratchTree(root, root);
        expect(() => developer.ensure(sha)).toThrow("unowned scratch");
        const dir = join(root, "owned");
        const owned = new ScratchTree(dir, root);
        owned.ensure(sha);
        owned.ensure(sha);
        writeFileSync(join(dir, "tracked.txt"), "precious edits");
        await expect(owned.checkout(sha)).rejects.toThrow("dirty scratch");
        expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("precious edits");
        expect(git(["rev-parse", "HEAD"], dir)).toBe(sha);
    } finally {
        process.chdir(original);
    }
});
