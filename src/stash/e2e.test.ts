import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "./commands/apply";
import { saveCommand } from "./commands/save";
import { unapplyCommand } from "./commands/unapply";
import { runGitIn } from "./lib/patch";

let work: string;
let origStashRoot: string | undefined;
let origCwd: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
    origCwd = process.cwd();
    work = await mkdtemp(join(tmpdir(), "stash-e2e-"));
    origStashRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    // Per-test stash root keeps parallel test files (and concurrent runs) from sharing the global SQLite/bare-repo state.
    process.env.GENESIS_TOOLS_STASH_ROOT = join(work, ".genesis-tools", "stash");
    projectA = join(work, "repo-a");
    projectB = join(work, "repo-b");
    for (const repo of [projectA, projectB]) {
        await runGitIn(work, ["init", repo.split("/").pop() ?? "", "--initial-branch=main"]);
        await runGitIn(repo, ["config", "user.email", "t@t"]);
        await runGitIn(repo, ["config", "user.name", "t"]);
        await writeFile(join(repo, "main.ts"), "export function main() { return 1; }\n");
        await runGitIn(repo, ["add", "main.ts"]);
        await runGitIn(repo, ["commit", "-m", "init"]);
    }
});
afterEach(async () => {
    // Restore cwd BEFORE rm — tests chdir into `work/...` and removing the current cwd makes
    // any subsequent Bun.spawn fail with posix_spawn ENOENT (macOS can't inherit a dead cwd).
    process.chdir(origCwd);
    if (origStashRoot !== undefined) {
        process.env.GENESIS_TOOLS_STASH_ROOT = origStashRoot;
    } else {
        delete process.env.GENESIS_TOOLS_STASH_ROOT;
    }
    await rm(work, { recursive: true, force: true });
});

describe.serial("stash e2e", () => {
    test("save in A → apply in B → unapply (discard) restores B to original", async () => {
        process.chdir(projectA);
        await writeFile(
            join(projectA, "main.ts"),
            "import { log } from './log';\nexport function main() { log('start'); return 1; }\n"
        );
        await saveCommand({ name: "logging", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "logging", verboseMarkers: false });
        const applied = await readFile(join(projectB, "main.ts"), "utf8");
        expect(applied).toContain("#region @stash:logging");
        expect(applied).toContain("log('start')");

        await unapplyCommand({ name: "logging", action: "start", decision: "discard-all-dangerous" });
        const after = await readFile(join(projectB, "main.ts"), "utf8");
        expect(after).not.toContain("#region @stash:logging");
        expect(after).not.toContain("log('start')");
    });

    test("save → save again with edits → versions=2", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "v1");
        await saveCommand({ name: "ver", mode: "all", tags: [], description: undefined });
        await writeFile(join(projectA, "main.ts"), "v2");
        await saveCommand({ name: "ver", mode: "all", tags: [], description: undefined });

        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM versions").get();
        expect(count?.c).toBe(2);
        db.close();
    });
});
