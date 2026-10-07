import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "./commands/apply";
import { saveCommand } from "./commands/save";
import { unapplyCommand } from "./commands/unapply";
import { updateCommand } from "./commands/update";
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
        expect(after).toBe("export function main() { return 1; }\n");
    });

    test("append and separated mixed deletion hunks restore every baseline byte", async () => {
        const baseline = Array.from({ length: 20 }, (_, index) => `line${index}();`).join("\n") + "\n";
        for (const repo of [projectA, projectB]) {
            await writeFile(join(repo, "main.ts"), baseline);
            await runGitIn(repo, ["add", "main.ts"]);
            await runGitIn(repo, ["commit", "-m", "long baseline"]);
        }
        const targetBaseline = `targetOnly();\n${baseline}`;
        await writeFile(join(projectB, "main.ts"), targetBaseline);
        await runGitIn(projectB, ["add", "main.ts"]);
        await runGitIn(projectB, ["commit", "-m", "target prefix"]);
        const changed = baseline.replace("line1();\n", "").replace("line17();", "replacement();") + "appended();\n";
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), changed);
        await saveCommand({ name: "mixed", mode: "all", tags: [], description: undefined });
        process.chdir(projectB);
        await applyCommand({ name: "mixed", verboseMarkers: false });
        const applied = await readFile(join(projectB, "main.ts"), "utf8");
        await writeFile(join(projectB, "main.ts"), applied.replace("line10();", "outsideEdit();"));
        await unapplyCommand({ name: "mixed", action: "start", decision: "discard-all-dangerous" });
        expect(await readFile(join(projectB, "main.ts"), "utf8")).toBe(
            targetBaseline.replace("line10();", "outsideEdit();")
        );
    });

    test("a deleted file is restored from its complete pre-image", async () => {
        process.chdir(projectA);
        await unlink(join(projectA, "main.ts"));
        await saveCommand({ name: "deleted-file", mode: "all", tags: [], description: undefined });
        process.chdir(projectB);
        await applyCommand({ name: "deleted-file", verboseMarkers: false });
        expect(existsSync(join(projectB, "main.ts"))).toBe(false);
        await unapplyCommand({ name: "deleted-file", action: "start", decision: "discard-all-dangerous" });
        expect(await readFile(join(projectB, "main.ts"), "utf8")).toBe("export function main() { return 1; }\n");
    });

    test("apply → edit → update capture → unapply restores the target's original baseline", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "export function main() { return 2; }\n");
        await saveCommand({ name: "edit-then-update", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "edit-then-update", verboseMarkers: false });
        const applied = await readFile(join(projectB, "main.ts"), "utf8");
        await writeFile(join(projectB, "main.ts"), applied.replace("return 2;", "return 3;"));

        await updateCommand({ name: "edit-then-update", decision: "capture-all-dangerous", action: "start" });
        await unapplyCommand({ name: "edit-then-update", action: "start", decision: "discard-all-dangerous" });

        expect(await readFile(join(projectB, "main.ts"), "utf8")).toBe("export function main() { return 1; }\n");
    });

    test("abort after a conflicting rename brings the renamed source back", async () => {
        for (const repo of [projectA, projectB]) {
            await writeFile(join(repo, "old name.ts"), "export const moved = 1;\nexport const kept = 1;\n");
            await runGitIn(repo, ["add", "old name.ts"]);
            await runGitIn(repo, ["commit", "-m", "add rename source"]);
        }
        // The rename applies cleanly while main.ts conflicts, so the session holds a moved file.
        process.chdir(projectA);
        await runGitIn(projectA, ["mv", "old name.ts", "new\tname.ts"]);
        await writeFile(join(projectA, "main.ts"), "export function main() { return 2; }\n");
        await runGitIn(projectA, ["add", "-A"]);
        await saveCommand({ name: "renamer", mode: "staged", tags: [], description: undefined });

        process.chdir(projectB);
        await writeFile(join(projectB, "main.ts"), "export function main() { return 9; }\n");
        await runGitIn(projectB, ["commit", "-am", "diverge"]);
        await applyCommand({ name: "renamer", verboseMarkers: false });
        expect(process.exitCode).toBe(1);
        expect(await readFile(join(projectB, "main.ts"), "utf8")).toContain("<<<<<<<");
        expect(existsSync(join(projectB, "old name.ts"))).toBe(false);
        process.exitCode = 0;

        await applyCommand({ name: "renamer", verboseMarkers: false, action: "abort" });
        expect(process.exitCode ?? 0).toBe(0);
        expect(await readFile(join(projectB, "old name.ts"), "utf8")).toBe(
            "export const moved = 1;\nexport const kept = 1;\n"
        );
        expect(existsSync(join(projectB, "new\tname.ts"))).toBe(false);
        expect(await readFile(join(projectB, "main.ts"), "utf8")).toBe("export function main() { return 9; }\n");
    });

    test("unapply keeps the application active when it cannot undo a symlink change", async () => {
        process.chdir(projectA);
        await symlink("main.ts", join(projectA, "alias.ts"));
        await runGitIn(projectA, ["add", "alias.ts"]);
        await saveCommand({ name: "linker", mode: "staged", tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "linker", verboseMarkers: false });
        expect((await lstat(join(projectB, "alias.ts"))).isSymbolicLink()).toBe(true);

        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const applicationState = () => {
            const db = openStashDb(new Database(new StashStorage().dbPath()));
            try {
                return db
                    .query<{ state: string }, []>(
                        "SELECT state FROM applications WHERE stash_id = (SELECT id FROM stashes WHERE name = 'linker')"
                    )
                    .get()?.state;
            } finally {
                db.close();
            }
        };

        await unapplyCommand({ name: "linker", action: "start", decision: "discard-all-dangerous" });
        expect(applicationState()).toBe("active");

        // Restored by hand: the next pass finds nothing left to undo and records the unapply.
        await unlink(join(projectB, "alias.ts"));
        await unapplyCommand({ name: "linker", action: "continue", decision: undefined });
        expect(applicationState()).toBe("unapplied");
    });

    test("a resumed apply whose decoration fails can be aborted and is not resumed twice", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "export function main() { return 2; }\n");
        await saveCommand({ name: "resume-fail", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        await writeFile(join(projectB, "main.ts"), "export function main() { return 9; }\n");
        await runGitIn(projectB, ["commit", "-am", "diverge"]);
        await applyCommand({ name: "resume-fail", verboseMarkers: false });
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;

        // Resolve the conflict, then make the file unwritable so decoration throws mid-resume.
        await writeFile(join(projectB, "main.ts"), "export function main() { return 2; }\n");
        await chmod(join(projectB, "main.ts"), 0o444);
        await expect(applyCommand({ name: "resume-fail", verboseMarkers: false, action: "resume" })).rejects.toThrow();

        await applyCommand({ name: "resume-fail", verboseMarkers: false, action: "resume" });
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;

        await applyCommand({ name: "resume-fail", verboseMarkers: false, action: "abort" });
        expect(process.exitCode ?? 0).toBe(0);
        expect(await readFile(join(projectB, "main.ts"), "utf8")).toBe("export function main() { return 9; }\n");
    });

    test("a failed archive write takes its applications row back, so abort leaves the stash re-appliable", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "export function main() { return 2; }\n");
        await saveCommand({ name: "archive-fail", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        const { Database } = await import("bun:sqlite");
        const { createHash } = await import("node:crypto");
        const { mkdir } = await import("node:fs/promises");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const storage = new StashStorage();
        const root = (await runGitIn(projectB, ["rev-parse", "--show-toplevel"])).trim();
        const projectHash = createHash("sha256").update(root).digest("hex");
        const readDb = () => openStashDb(new Database(storage.dbPath()));
        const db = readDb();
        const stashId = db.query<{ id: string }, []>("SELECT id FROM stashes WHERE name = 'archive-fail'").get()?.id;
        db.close();
        // A directory where the archive file goes makes the archive rename fail.
        const archive = join(storage.stateDir(), `${projectHash}--applied--${stashId}.json`);
        await mkdir(archive, { recursive: true });

        await expect(applyCommand({ name: "archive-fail", verboseMarkers: false })).rejects.toThrow();
        const check = readDb();
        const active = check
            .query<{ c: number }, [string]>(
                "SELECT COUNT(*) as c FROM applications WHERE stash_id = ? AND state = 'active'"
            )
            .get(stashId ?? "");
        check.close();
        expect(active?.c).toBe(0);

        await applyCommand({ name: "archive-fail", verboseMarkers: false, action: "abort" });
        expect(await readFile(join(projectB, "main.ts"), "utf8")).toBe("export function main() { return 1; }\n");
        await rm(archive, { recursive: true });
        // Abort restores the original index bytes, stale stat data included; git status would refresh it.
        await runGitIn(projectB, ["update-index", "-q", "--refresh"]);
        await applyCommand({ name: "archive-fail", verboseMarkers: false });
        expect(process.exitCode ?? 0).toBe(0);
    });

    test("a patch git rejects outright leaves no session behind, so a retry is not blocked", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "export function main() { return 2; }\n");
        await saveCommand({ name: "rejected", mode: "all", tags: [], description: undefined });

        process.chdir(projectB);
        await unlink(join(projectB, "main.ts"));
        await runGitIn(projectB, ["commit", "-am", "remove target"]);
        await applyCommand({ name: "rejected", verboseMarkers: false });
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;

        const { StashStorage } = await import("./lib/storage");
        const { readdir } = await import("node:fs/promises");
        const sessions = (await readdir(new StashStorage().stateDir())).filter((f) => f.includes("--apply--"));
        expect(sessions).toEqual([]);
    });

    test("new-file save --mode staged → apply → unapply removes the file (no empty husk)", async () => {
        // Mirrors the Contoso burn-auth-callback-record workflow: `git add` a brand-new file
        // (RecordDemoBadge.tsx-style), `tools stash save --mode staged`, apply elsewhere, then
        // unapply should DELETE the file in the target, not leave an empty husk.
        process.chdir(projectA);
        await writeFile(join(projectA, "RecordDemoBadge.tsx"), "export const RecordDemoBadge = () => null;\n");
        await runGitIn(projectA, ["add", "RecordDemoBadge.tsx"]);
        await saveCommand({ name: "rec-overlay", mode: "staged", tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "rec-overlay", verboseMarkers: false });
        const appliedFile = join(projectB, "RecordDemoBadge.tsx");
        expect(existsSync(appliedFile)).toBe(true);
        const applied = await readFile(appliedFile, "utf8");
        expect(applied).toContain("RecordDemoBadge");
        expect(applied).toContain("#region @stash:rec-overlay");

        await unapplyCommand({ name: "rec-overlay", action: "start", decision: "discard-all-dangerous" });
        // Husk check: the file existed only inside the overlay, so unapply must remove it,
        // not leave a 0-byte file behind. Anything that's-not-the-original-baseline is wrong.
        expect(existsSync(appliedFile)).toBe(false);
    });

    test("save --regions <name> captures only hunks overlapping the named author marker block", async () => {
        // The filter operates at HUNK granularity (it does not slice individual hunks). For it to
        // distinguish "keep" from "drop", the two edits have to land in separate hunks — i.e.
        // there must be ≥3 lines of unchanged context between them. This is the normal case when
        // you mark regions in code you've been iterating on; whole-file rewrites collapse into one
        // hunk and the filter degrades to "include everything that hunk touched."
        const base = [
            "export function f() {",
            "  // #region @stash:keep",
            "  // body to fill in",
            "  // #endregion @stash:keep",
            "  ",
            "  const middleA = 0;",
            "  const middleB = 1;",
            "  const middleC = 2;",
            "  const middleD = 3;",
            "  ",
            "  // #region @stash:drop",
            "  // body to fill in",
            "  // #endregion @stash:drop",
            "}",
            "",
        ].join("\n");
        const edited = base
            .replace(
                "// body to fill in\n  // #endregion @stash:keep",
                "console.log('keep');\n  // #endregion @stash:keep"
            )
            .replace(
                "// body to fill in\n  // #endregion @stash:drop",
                "console.log('drop');\n  // #endregion @stash:drop"
            );

        // Seed BOTH repos with the same base so apply's 3-way merge has a matching pre-image.
        for (const repo of [projectA, projectB]) {
            await writeFile(join(repo, "main.ts"), base);
            await runGitIn(repo, ["add", "main.ts"]);
            await runGitIn(repo, ["commit", "-qm", "base with empty regions"]);
        }

        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), edited);
        await saveCommand({ name: "scoped", mode: "regions", regions: ["keep"], tags: [], description: undefined });

        process.chdir(projectB);
        await applyCommand({ name: "scoped", verboseMarkers: false });
        const applied = await readFile(join(projectB, "main.ts"), "utf8");
        expect(applied).toContain("console.log('keep')");
        expect(applied).not.toContain("console.log('drop')");
        expect(applied).toContain("#region @stash:scoped");
    });

    test("save → save again with edits → versions=2", async () => {
        process.chdir(projectA);
        await writeFile(join(projectA, "main.ts"), "v1");
        await saveCommand({ name: "ver", mode: "all", tags: [], description: undefined });
        await writeFile(join(projectA, "main.ts"), "v2");
        // forceBump skips the aggregate diff confirm (required in non-TTY test environment)
        await saveCommand({ name: "ver", mode: "all", tags: [], description: undefined, forceBump: true });

        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM versions").get();
        expect(count?.c).toBe(2);
        db.close();
    });

    test("save same-name --force-bump skips prompt and writes v2", async () => {
        process.chdir(projectA);
        // Write content different from HEAD so the first save captures real changes
        await writeFile(join(projectA, "main.ts"), "export function main() { return 'v1'; }\n");
        await saveCommand({ name: "bump-test", mode: "all", tags: [], description: undefined });

        // Modify and save again with forceBump — should write v2 without any confirm prompt
        await writeFile(join(projectA, "main.ts"), "export function main() { return 'v2'; }\n");
        await saveCommand({ name: "bump-test", mode: "all", tags: [], description: undefined, forceBump: true });

        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const count = db
            .query<{ c: number }, []>(
                "SELECT COUNT(*) as c FROM versions WHERE stash_id IN (SELECT id FROM stashes WHERE name = 'bump-test')"
            )
            .get();
        expect(count?.c).toBe(2);
        db.close();
    });

    test("save same-name in non-TTY without --force-bump aborts with suggestion", async () => {
        process.chdir(projectA);
        // Write content different from HEAD so the first save captures real changes
        await writeFile(join(projectA, "main.ts"), "export function main() { return 'a'; }\n");
        await saveCommand({ name: "no-bump", mode: "all", tags: [], description: undefined });

        // Modify and attempt save again without forceBump — non-TTY (bun test is non-TTY) should abort
        await writeFile(join(projectA, "main.ts"), "export function main() { return 'b'; }\n");
        await saveCommand({ name: "no-bump", mode: "all", tags: [], description: undefined, forceBump: false });

        // v2 must NOT have been written — DB should still show only 1 version
        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const count = db
            .query<{ c: number }, []>(
                "SELECT COUNT(*) as c FROM versions WHERE stash_id IN (SELECT id FROM stashes WHERE name = 'no-bump')"
            )
            .get();
        expect(count?.c).toBe(1);
        db.close();
    });

    test("save → regions table is populated", async () => {
        process.chdir(projectA);
        await writeFile(
            join(projectA, "main.ts"),
            "import { log } from './log';\nexport function main() { log('start'); return 1; }\n"
        );
        await saveCommand({ name: "regions-check", mode: "all", tags: [], description: undefined });

        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions").get();
        expect((count?.c ?? 0) > 0).toBe(true);
        db.close();
    });

    test("curate-after-apply: save → apply → delete marker pair → update yields v2", async () => {
        // Seed both repos with two extra files (one region per file so bootstrap doesn't confuse
        // marker lookup across same-named hunks within the same file).
        for (const repo of [projectA, projectB]) {
            await writeFile(join(repo, "file-a.ts"), "export const a = 'base-a';\n");
            await writeFile(join(repo, "file-b.ts"), "export const b = 'base-b';\n");
            await runGitIn(repo, ["add", "file-a.ts", "file-b.ts"]);
            await runGitIn(repo, ["commit", "-m", "add extra files"]);
        }

        // Save v1 from projectA: both files modified → two separate patch regions.
        process.chdir(projectA);
        await writeFile(join(projectA, "file-a.ts"), "export const a = 'overlay-a';\n");
        await writeFile(join(projectA, "file-b.ts"), "export const b = 'overlay-b';\n");
        await saveCommand({ name: "curator", mode: "all", tags: [], description: undefined });

        // Apply v1 in projectB — each file gets its own marker pair.
        process.chdir(projectB);
        await applyCommand({ name: "curator", verboseMarkers: false });

        // User "curates": deletes file-a.ts marker pair, keeping only the file-b overlay.
        const fileAContent = await readFile(join(projectB, "file-a.ts"), "utf8");
        const fileALines = fileAContent.split("\n");
        const openIdx = fileALines.findIndex((l) => l.includes("#region @stash:curator"));
        const closeIdx = fileALines.findIndex((l, i) => i > openIdx && l.includes("#endregion @stash:curator"));
        await writeFile(
            join(projectB, "file-a.ts"),
            [...fileALines.slice(0, openIdx), ...fileALines.slice(closeIdx + 1)].join("\n")
        );

        // Update with capture-all-dangerous: v2 should be written capturing both regions
        // (alpha as "missing" → captured empty; beta as "unchanged" → auto-captured).
        await updateCommand({ name: "curator", decision: "capture-all-dangerous", action: "start" });

        // Assert v2 exists and applications.version_id was advanced.
        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));

        const versions = db
            .query<{ version: number; id: string }, []>(
                "SELECT version, id FROM versions WHERE stash_id IN (SELECT id FROM stashes WHERE name = 'curator') ORDER BY version"
            )
            .all();
        expect(versions.length).toBe(2);
        expect(versions[1]?.version).toBe(2);

        const v2Id = versions[1]?.id;
        // Query by stash_id (not project_path) to avoid /var vs /private/var symlink mismatch on macOS.
        const curatorStash = db.query<{ id: string }, []>("SELECT id FROM stashes WHERE name = 'curator'").get();
        const app = db
            .query<{ version_id: string }, [string]>(
                "SELECT version_id FROM applications WHERE stash_id = ? AND state = 'active'"
            )
            .get(curatorStash!.id);
        expect(app?.version_id).toBe(v2Id);

        db.close();
    });

    test("merge via curate: apply A + B in projectB → discard A → save combined captures only B", async () => {
        // Seed both repos with two separate files — one per feature stash.
        for (const repo of [projectA, projectB]) {
            await writeFile(join(repo, "feat-a.ts"), "export const a = 'base-a';\n");
            await writeFile(join(repo, "feat-b.ts"), "export const b = 'base-b';\n");
            await runGitIn(repo, ["add", "feat-a.ts", "feat-b.ts"]);
            await runGitIn(repo, ["commit", "-m", "add feature files"]);
        }

        // Save "feat-a" (only feat-a.ts changed).
        process.chdir(projectA);
        await writeFile(join(projectA, "feat-a.ts"), "export const a = 'overlay-a';\n");
        await saveCommand({ name: "feat-a", mode: "all", tags: [], description: undefined });

        // Restore feat-a.ts to base, then save "feat-b" (only feat-b.ts changed).
        await writeFile(join(projectA, "feat-a.ts"), "export const a = 'base-a';\n");
        await writeFile(join(projectA, "feat-b.ts"), "export const b = 'overlay-b';\n");
        await saveCommand({ name: "feat-b", mode: "all", tags: [], description: undefined });

        // Apply both stashes in projectB.
        process.chdir(projectB);
        await applyCommand({ name: "feat-a", verboseMarkers: false });
        await applyCommand({ name: "feat-b", verboseMarkers: false });

        // User curates: rejects feat-a by restoring feat-a.ts to its original base content.
        // This leaves feat-a.ts at HEAD (no diff) so save --mode all won't capture it.
        await writeFile(join(projectB, "feat-a.ts"), "export const a = 'base-a';\n");

        // Save "combined" from projectB — should capture only feat-b.ts changes.
        await saveCommand({ name: "combined", mode: "all", tags: [], description: undefined });

        // Read combined's PATCH.diff and verify it has feat-b content and NOT feat-a content.
        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("./lib/stash-db");
        const { StashStorage } = await import("./lib/storage");
        const { StoreRepo } = await import("./lib/store-repo");
        const storage = new StashStorage();
        const db = openStashDb(new Database(storage.dbPath()));

        const combined = db.query<{ id: string }, []>("SELECT id FROM stashes WHERE name = 'combined'").get();
        expect(combined).toBeDefined();

        const version = db
            .query<{ patch_ref: string }, [string]>(
                "SELECT patch_ref FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1"
            )
            .get(combined!.id);
        expect(version).toBeDefined();

        const repo = new StoreRepo(storage.storeRepoDir());
        const patch = await repo.readFileAt(version!.patch_ref, "PATCH.diff");
        expect(patch).toContain("overlay-b");
        expect(patch).not.toContain("overlay-a");

        db.close();
    });
});
