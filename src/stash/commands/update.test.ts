import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "../lib/patch";
import { applyCommand } from "./apply";
import { saveCommand } from "./save";
import { updateCommand } from "./update";

let work: string;
let repo: string;
let origCwd: string;
let origStashRoot: string | undefined;

beforeEach(async () => {
    origCwd = process.cwd();
    work = await mkdtemp(join(tmpdir(), "update-test-"));
    origStashRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    process.env.GENESIS_TOOLS_STASH_ROOT = join(work, ".genesis-tools", "stash");
    repo = join(work, "repo");
    await runGitIn(work, ["init", "repo", "--initial-branch=main"]);
    await runGitIn(repo, ["config", "user.email", "t@t"]);
    await runGitIn(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "x.ts"), "export const x = 1;\n");
    await runGitIn(repo, ["add", "x.ts"]);
    await runGitIn(repo, ["commit", "-qm", "init"]);
});

afterEach(async () => {
    process.chdir(origCwd);
    if (origStashRoot !== undefined) {
        process.env.GENESIS_TOOLS_STASH_ROOT = origStashRoot;
    } else {
        delete process.env.GENESIS_TOOLS_STASH_ROOT;
    }
    await rm(work, { recursive: true, force: true });
});

describe("update command", () => {
    test("captures current code as v_next; applications.version_id advances", async () => {
        process.chdir(repo);
        // 1. Save v1 of a stash from working tree.
        await writeFile(join(repo, "x.ts"), "export const x = 1;\nconst log = (s: string) => console.log(s);\n");
        await saveCommand({ name: "logger", mode: "all", regions: undefined, tags: [], description: undefined });
        // 2. Reset and apply (round-trip in the same repo).
        await runGitIn(repo, ["checkout", "x.ts"]);
        await applyCommand({ name: "logger", verboseMarkers: false });
        // 3. Edit the applied region.
        const content = await readFile(join(repo, "x.ts"), "utf8");
        const edited = content.replace("console.log(s)", "console.warn(s)");
        await writeFile(join(repo, "x.ts"), edited);
        // 4. Run update with blanket capture decision.
        await updateCommand({ name: "logger", decision: "capture-all-dangerous" });
        // 5. Confirm v2 exists in the DB and applications.version_id advanced.
        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("../lib/stash-db");
        const { StashStorage } = await import("../lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const versionCount = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM versions").get();
        expect(versionCount?.c).toBe(2);
        const app = db
            .query<{ version: number }, []>(
                "SELECT v.version FROM applications a JOIN versions v ON a.version_id = v.id WHERE a.state = 'active'"
            )
            .get();
        expect(app?.version).toBe(2);
        db.close();
    });

    test("errors when stash is not applied in cwd", async () => {
        process.chdir(repo);
        await writeFile(join(repo, "x.ts"), "export const x = 1;\nconst log = (s: string) => console.log(s);\n");
        await saveCommand({ name: "unapplied", mode: "all", regions: undefined, tags: [], description: undefined });
        await runGitIn(repo, ["checkout", "x.ts"]);
        // updateCommand now sets process.exitCode instead of calling process.exit(), so
        // finally-block cleanup (db.close()) runs on this error path too. Anchored on
        // exitCode === 1 rather than a generic resolve — a setup mishap (missing file, bad
        // fixture, etc.) would throw instead, so this still proves we hit the
        // "not applied here" branch specifically.
        await updateCommand({ name: "unapplied", decision: undefined });
        expect(process.exitCode).toBe(1);
    });
});
