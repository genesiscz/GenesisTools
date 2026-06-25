import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { newStashId, shortId } from "../lib/ids";
import { commentSyntaxForFile } from "../lib/languages";
import { emitCloseMarker, emitOpenMarker } from "../lib/markers";
import { applyPatch, listFilesInPatch, runGitIn } from "../lib/patch";
import { detectProject } from "../lib/projects";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { StoreRepo } from "../lib/store-repo";
import { ui } from "../lib/ui";
import type { ApplicationRow, StashRow, VersionRow } from "../types";

const { log } = logger.scoped("stash:apply");

// Target ref for the fetched baseline. NOTE: git rejects ref-name path components that begin with `.`,
// so `refs/.gtstash-baseline` would silently fail with "invalid refspec". Keep the dot OUT.
const BASELINE_TARGET_REF = "refs/gtstash-baseline";

export interface ApplyOptions {
    name: string;
    version?: number;
    verboseMarkers: boolean;
}

export async function applyCommand(opts: ApplyOptions): Promise<void> {
    log.debug({ opts }, "applyCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }
    log.debug({ rootPath: project.rootPath, origin: project.origin }, "project resolved");

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);
        db.close();
        process.exit(1);
    }

    const version = opts.version
        ? db
              .query<VersionRow, [string, number]>("SELECT * FROM versions WHERE stash_id = ? AND version = ?")
              .get(stash.id, opts.version)
        : db
              .query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1")
              .get(stash.id);
    if (!version) {
        ui.err(`no version found for "${opts.name}"${opts.version ? ` @v${opts.version}` : ""}`);
        db.close();
        process.exit(1);
    }
    log.debug({ stashId: stash.id, version: version.version, patch_ref: version.patch_ref }, "version resolved");

    const existingActive = db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(stash.id, project.rootPath);
    if (existingActive) {
        ui.err(`"${opts.name}" is already applied here. Use 'unapply' or 'update'.`);
        db.close();
        process.exit(1);
    }

    const repo = new StoreRepo(storage.storeRepoDir());
    const patch = await repo.readFileAt(version.patch_ref, "PATCH.diff");
    if (!patch) {
        ui.err(`patch missing from store at ${version.patch_ref}`);
        db.close();
        process.exit(1);
    }
    log.debug({ patchBytes: patch.length }, "patch fetched from store");

    const baselineRef = `refs/baselines/${stash.id}/v${version.version}`;
    await fetchBaselineBlobs({ projectRoot: project.rootPath, storeDir: storage.storeRepoDir(), baselineRef });

    ui.info(`applying "${opts.name}" v${version.version} [id=${shortId(stash.id)}]`);

    try {
        await applyPatch({ repoDir: project.rootPath, patch, threeWay: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ui.err(`apply failed: ${message}`);
        ui.warn(
            "apply-conflict state machine deferred to v1.1; resolve conflicts manually and re-run with --resume (future)"
        );
        db.close();
        process.exit(1);
    }

    const affectedFiles = await listFilesInPatch({ repoDir: project.rootPath, patch });
    await decorateAppliedRegions({
        projectRoot: project.rootPath,
        files: affectedFiles,
        patch,
        stashName: opts.name,
        stashId: stash.id,
        version: version.version,
        verbose: opts.verboseMarkers,
        sourceRepo: version.source_repo_path,
        sourceSha: version.source_sha,
    });

    const now = new Date().toISOString();
    db.run(
        `INSERT INTO applications (id, stash_id, version_id, project_path, project_origin, project_sha_at_apply, applied_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [newStashId(), stash.id, version.id, project.rootPath, project.origin, project.sha, now]
    );

    // Drop the fetched baseline ref — it was only needed to seed 3-way merge blobs into objects/.
    // Failure is harmless: git's GC will reap unreachable objects eventually.
    await runGitIn(project.rootPath, ["update-ref", "-d", BASELINE_TARGET_REF]).catch((err) => {
        log.debug({ err }, "baseline ref cleanup failed (non-fatal)");
    });

    ui.ok(`applied "${opts.name}" v${version.version}`);
    ui.info(`  ${affectedFiles.length} files affected`);

    db.close();
    log.debug({ stashId: stash.id, version: version.version, files: affectedFiles.length }, "stash applied");
}

async function fetchBaselineBlobs(args: { projectRoot: string; storeDir: string; baselineRef: string }): Promise<void> {
    try {
        await runGitIn(args.projectRoot, [
            "fetch",
            "--no-tags",
            args.storeDir,
            `${args.baselineRef}:${BASELINE_TARGET_REF}`,
        ]);
        log.debug({ ref: BASELINE_TARGET_REF }, "baseline blobs fetched into project objects");
    } catch (err) {
        log.warn({ err }, "baseline fetch failed; --3way will fall back to fuzz matching");
    }
}

async function decorateAppliedRegions(args: {
    projectRoot: string;
    files: string[];
    patch: string;
    stashName: string;
    stashId: string;
    version: number;
    verbose: boolean;
    sourceRepo: string | null;
    sourceSha: string | null;
}): Promise<void> {
    const hunks = parseDiffHunks(args.patch);
    for (const [filePath, fileHunks] of Object.entries(hunks)) {
        const abs = join(args.projectRoot, filePath);
        const syntax = commentSyntaxForFile(filePath);
        let content: string;
        try {
            content = await readFile(abs, "utf8");
        } catch {
            continue;
        }
        const lines = content.split("\n");
        for (let h = fileHunks.length - 1; h >= 0; h--) {
            const hunk = fileHunks[h];
            if (!hunk) {
                continue;
            }
            // PR #222 t3: pure-deletion hunks (no `+` lines, newLines === 0) have nothing to wrap.
            // Emitting a marker pair here would produce an empty `// #region … // #endregion …`
            // sandwich with no body, which `parseMarkers` would then "find" with a zero-line span.
            if (hunk.newLines === 0 || hunk.addedCount === 0) {
                continue;
            }
            const meta: Record<string, unknown> = { id: shortId(args.stashId), v: args.version };
            if (args.verbose) {
                meta.hunk = h + 1;
                if (args.sourceRepo) {
                    meta.src = `${args.sourceRepo.split("/").pop()}@${args.sourceSha?.slice(0, 7) ?? "?"}`;
                }
                meta.applied = new Date().toISOString();
            }
            const openLine = emitOpenMarker({ name: args.stashName, meta, syntax });
            const closeLine = emitCloseMarker({ name: args.stashName, syntax });
            const closeIdx = hunk.newStart + hunk.newLines - 1;
            const openIdx = hunk.newStart - 1;
            lines.splice(closeIdx, 0, closeLine);
            lines.splice(openIdx, 0, openLine);
        }
        await writeFile(abs, lines.join("\n"));
    }
}

interface DiffHunk {
    newStart: number;
    newLines: number;
    addedCount: number;
}

function parseDiffHunks(patch: string): Record<string, DiffHunk[]> {
    const result: Record<string, DiffHunk[]> = {};
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let currentHunk: DiffHunk | null = null;
    // Unified-diff hunk header `@@ -orig +newStart,newLines @@` — capture newStart + newLines for marker placement.
    const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
    // Post-image file header from `git diff --dst-prefix=b/` — captures relative path.
    const FILE_RE = /^\+\+\+ b\/(.+)$/;
    for (const line of lines) {
        const fm = FILE_RE.exec(line);
        if (fm) {
            currentFile = fm[1] ?? null;
            currentHunk = null;
            continue;
        }
        const hm = HUNK_RE.exec(line);
        if (hm && currentFile) {
            currentHunk = {
                newStart: Number(hm[1]),
                newLines: Number(hm[2] ?? "1"),
                addedCount: 0,
            };
            if (!result[currentFile]) {
                result[currentFile] = [];
            }
            result[currentFile].push(currentHunk);
            continue;
        }
        // `+++ b/path` file headers always appear BEFORE the first `@@`, so currentHunk is null
        // there and we never reach this branch — no startsWith("+++") guard needed.
        if (currentHunk && line.startsWith("+")) {
            currentHunk.addedCount++;
        }
    }
    return result;
}
