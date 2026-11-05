import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProjects, ScratchTree, testFolders } from "./layer-cut";
import { expect, test } from "bun:test";
import { loadTable } from "./layer-cut-tables/load";
import unified from "./layer-cut-tables/unified";

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
    const checked = new Map([["src/widget/index.ts", entry], ["src/widget/index.test.ts", entry]]);
    expect(testFolders(["src/widget/index.ts"], checked)).toEqual(["src/widget"]);
    expect(testFolders(["src/widget/index.ts"], new Map())).toEqual([]);
});

test("project discovery includes mobile configs for selected mobile files", () => {
    const entry = { mode: "100644", sha: "fixture" };
    const tree = new Map(["tsconfig.json", "DevDashboard/mobile/tsconfig.json", "DevDashboard/mobile/package.json"].map((file) => [file, entry]));
    expect(checkProjects(["DevDashboard/mobile/src/screen.tsx"], tree)).toEqual(["DevDashboard/mobile/tsconfig.json", "tsconfig.json"]);
    expect(checkProjects(["src/widget/index.ts"], tree)).toEqual(["tsconfig.json"]);
});

test("--table requires a module path", async () => {
    await expect(loadTable(["--table"])).rejects.toThrow("requires a path");
    await expect(loadTable(["--table", "--tests"])).rejects.toThrow("requires a path");
});


test("scratch reuse refuses developer checkouts and dirty owned trees", async () => {
    const original = process.cwd();
    const root = mkdtempSync("/tmp/cc/GenesisTools/a7346bf7-545b-49f3-9f68-bfea934db066/rl-739/ownership-");
    const git = (args: string[], cwd = root): string => {
        const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
