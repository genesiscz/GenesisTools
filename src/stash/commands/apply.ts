import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import {
    applicationRestorePatch,
    captureApplySnapshot,
    rewriteConfinedText,
    sameApplySnapshot,
} from "../lib/apply-recovery";
import { ApplySession } from "../lib/apply-session";
import { newStashId, shortId } from "../lib/ids";
import { commentSyntaxForFile } from "../lib/languages";
import { emitCloseMarker, emitOpenMarker } from "../lib/markers";
import { applyPatch, listFilesInPatch, listPatchPaths, runGitIn } from "../lib/patch";
import { type DetectedProject, detectProject } from "../lib/projects";
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
    action?: "start" | "resume" | "abort";
}

export async function applyCommand(opts: ApplyOptions): Promise<void> {
    log.debug({ opts }, "applyCommand");
    const action = opts.action ?? "start";

    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }
    log.debug({ rootPath: project.rootPath, origin: project.origin }, "project resolved");

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    try {
        const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
        if (!stash) {
            ui.err(`stash "${opts.name}" not found`);

            process.exitCode = 1;
            return;
        }

        const projectHash = createHash("sha256").update(project.rootPath).digest("hex");

        // --abort: restore conflicted files from HEAD and delete the session state.
        if (action === "abort") {
            const session = await ApplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
            if (!session) {
                ui.info("no in-progress apply session");

                return;
            }
            try {
                await session.restore();
                await session.abort();
            } catch (error) {
                log.warn({ error }, "apply recovery failed; preserving session");
                ui.err(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }
            ui.ok("aborted");

            return;
        }

        const pending = await ApplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (action === "start" && pending) {
            ui.err("an apply session is already pending; resume or abort it first");
            process.exitCode = 1;
            return;
        }
        const version =
            action === "resume" && pending
                ? db
                      .query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?")
                      .get(pending.snapshot().versionId)
                : opts.version
                  ? db
                        .query<VersionRow, [string, number]>(
                            "SELECT * FROM versions WHERE stash_id = ? AND version = ?"
                        )
                        .get(stash.id, opts.version)
                  : db
                        .query<VersionRow, [string]>(
                            "SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1"
                        )
                        .get(stash.id);
        if (!version) {
            ui.err(`no version found for "${opts.name}"${opts.version ? ` @v${opts.version}` : ""}`);

            process.exitCode = 1;
            return;
        }
        log.debug({ stashId: stash.id, version: version.version, patch_ref: version.patch_ref }, "version resolved");

        const repo = new StoreRepo(storage.storeRepoDir());
        const patch = await repo.readFileAt(version.patch_ref, "PATCH.diff");
        if (!patch) {
            ui.err(`patch missing from store at ${version.patch_ref}`);

            process.exitCode = 1;
            return;
        }
        log.debug({ patchBytes: patch.length }, "patch fetched from store");

        // --resume: check remaining conflicts, then finish decoration and insert the application row.
        if (action === "resume") {
            const session = await ApplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
            if (!session) {
                ui.err(`no in-progress apply session for "${opts.name}"; run 'apply' to start`);

                process.exitCode = 1;
                return;
            }

            const outcome = session.snapshot().outcome;
            if (outcome === "failed" || outcome === "applied") {
                ui.err(
                    outcome === "failed"
                        ? "the last apply failed without conflicts, so there is nothing to resume"
                        : "the last apply landed but did not finish recording itself, so it cannot be resumed"
                );
                ui.info(`  ${toolCommand("stash apply", opts.name, "--abort")}    (restores the files and the index)`);

                process.exitCode = 1;
                return;
            }

            const remaining = await session.remainingConflicts();
            if (remaining.length > 0) {
                ui.err(`${remaining.length} file(s) still have conflict markers:`);
                for (const f of remaining) {
                    ui.warn(`  ${f}`);
                }
                ui.info("resolve all conflicts, then re-run with --resume");

                process.exitCode = 1;
                return;
            }

            if (!session.snapshot().before) {
                throw new Error("Cannot safely resume a legacy apply without its original file snapshots");
            }
            const affectedFiles = await listFilesInPatch({ repoDir: project.rootPath, patch });
            await finalizeApplication({ session, db, project, stash, version, opts, affectedFiles });
            ui.ok(`applied "${opts.name}" v${version.version} (after conflict resolution)`);
            ui.info(`  ${affectedFiles.length} files affected`);

            log.debug({ stashId: stash.id, version: version.version }, "stash applied after conflict resolution");
            return;
        }

        // action === "start": normal apply path.
        const existingActive = db
            .query<ApplicationRow, [string, string]>(
                "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
            )
            .get(stash.id, project.rootPath);
        if (existingActive) {
            ui.err(`"${opts.name}" is already applied here. Use 'unapply' or 'update'.`);

            process.exitCode = 1;
            return;
        }

        const baselineRef = `refs/baselines/${stash.id}/v${version.version}`;
        await fetchBaselineBlobs({ projectRoot: project.rootPath, storeDir: storage.storeRepoDir(), baselineRef });

        ui.info(`applying "${opts.name}" v${version.version} [id=${shortId(stash.id)}]`);

        // List affected files BEFORE applying so we can scan them for conflict markers in the catch block.
        const affectedFiles = await listFilesInPatch({ repoDir: project.rootPath, patch });
        // The snapshot covers both sides of a rename, so --abort can bring a moved source back.
        const snapshotFiles = await listPatchPaths({ repoDir: project.rootPath, patch });
        const session = await ApplySession.start({
            stashId: stash.id,
            stashName: opts.name,
            versionId: version.id,
            version: version.version,
            projectPath: project.rootPath,
            projectHash,
            conflictedFiles: [],
            stateDir: storage.stateDir(),
            before: await captureApplySnapshot({ root: project.rootPath, files: snapshotFiles }),
        });

        try {
            await applyPatch({ repoDir: project.rootPath, patch, threeWay: true });
        } catch (err) {
            // Scan the affected files for conflict markers to distinguish a conflict from a hard failure.
            const conflictedFiles: string[] = [];
            for (const file of affectedFiles) {
                const abs = join(project.rootPath, file);
                try {
                    const content = await readFile(abs, "utf8");
                    if (content.includes("<<<<<<<")) {
                        conflictedFiles.push(file);
                    }
                } catch (readErr) {
                    const code =
                        readErr && typeof readErr === "object" && "code" in readErr
                            ? (readErr as NodeJS.ErrnoException).code
                            : undefined;

                    if (code === "ENOENT") {
                        // Patch deleted the file or it never existed — genuinely not conflicted.
                        continue;
                    }

                    // Permission/IO errors are real failures, not "no conflict" — surface them and
                    // treat the file as needing manual review rather than silently passing it through.
                    log.warn(
                        { err: readErr, file },
                        "conflict scan: could not read file; treating as conflicted for manual review"
                    );
                    conflictedFiles.push(file);
                }
            }

            await session.captureResult(conflictedFiles, conflictedFiles.length > 0 ? "conflict" : "failed");
            if (conflictedFiles.length > 0) {
                ui.err(`apply conflict: ${conflictedFiles.length} file(s) need manual resolution`);
                for (const f of conflictedFiles) {
                    ui.warn(`  conflict: ${f}`);
                }
                ui.info("resolve conflicts manually, then:");
                ui.info(`  ${toolCommand("stash apply", opts.name, "--resume")}`);
                ui.info(`  ${toolCommand("stash apply", opts.name, "--abort")}    (to reverse the partial apply)`);

                process.exitCode = 1;
                return;
            }

            // Not a conflict: surface a clean error. Git's raw stderr ("repository lacks the
            // necessary blob to perform 3-way merge", "Falling back to direct application", etc.)
            // is verbose and exposes internals — replace it with a human-readable message when we
            // can identify the failure mode, fall through to raw on the unknown ones.
            const raw = err instanceof Error ? err.message : String(err);
            const friendly = (() => {
                if (raw.includes("lacks the necessary blob") || raw.includes("patch does not apply")) {
                    return (
                        `cannot apply patch — the target files have diverged too far from the stash's source baseline.\n` +
                        `  Try saving a new stash from this project instead, or apply in a project closer to the original source.`
                    );
                }
                return raw;
            })();
            ui.err(`apply failed: ${friendly}`);

            const { before, after } = session.snapshot();
            if (before && after && sameApplySnapshot(before, after)) {
                // git left the files and the index untouched, so there is nothing to recover.
                await session.abort();
            } else {
                ui.info("the failed apply changed files; restore them with:");
                ui.info(`  ${toolCommand("stash apply", opts.name, "--abort")}`);
            }

            process.exitCode = 1;
            return;
        }

        await finalizeApplication({ session, db, project, stash, version, opts, affectedFiles });

        // Drop the fetched baseline ref — it was only needed to seed 3-way merge blobs into objects/.
        // Failure is harmless: git's GC will reap unreachable objects eventually.
        await runGitIn(project.rootPath, ["update-ref", "-d", BASELINE_TARGET_REF]).catch((err) => {
            log.debug({ err }, "baseline ref cleanup failed (non-fatal)");
        });

        ui.ok(`applied "${opts.name}" v${version.version}`);
        ui.info(`  ${affectedFiles.length} files affected`);

        log.debug({ stashId: stash.id, version: version.version, files: affectedFiles.length }, "stash applied");
    } finally {
        db.close();
    }
}

/**
 * Decorate, record and archive an apply whose patch is on disk (fresh, or resumed after the user
 * resolved conflicts). The applied state is checkpointed first and again after decoration, so if
 * decoration, the applications row or the archive throws, the session matches the disk: --abort
 * restores it, and --resume refuses to decorate a second time.
 */
async function finalizeApplication(args: {
    session: ApplySession;
    db: Database;
    project: DetectedProject;
    stash: StashRow;
    version: VersionRow;
    opts: ApplyOptions;
    affectedFiles: string[];
}): Promise<void> {
    const { session, project, stash, version, opts } = args;
    await session.captureResult([], "applied");

    const before = session.snapshot().before;
    if (!before) {
        throw new Error("Apply recovery snapshot missing");
    }
    const { patch: restorePatch, unsupportedFiles } = await applicationRestorePatch({
        root: project.rootPath,
        before,
    });
    try {
        await decorateAppliedRegions({
            projectRoot: project.rootPath,
            files: args.affectedFiles,
            patch: restorePatch,
            stashName: opts.name,
            stashId: stash.id,
            version: version.version,
            verbose: opts.verboseMarkers,
            sourceRepo: version.source_repo_path,
            sourceSha: version.source_sha,
        });
    } finally {
        // Markers changed the files; the recovery "after" state must match what is on disk.
        await session.captureResult([], "applied");
    }

    const now = new Date().toISOString();
    args.db.run(
        `INSERT INTO applications (id, stash_id, version_id, project_path, project_origin, project_sha_at_apply, applied_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [newStashId(), stash.id, version.id, project.rootPath, project.origin, project.sha, now]
    );

    await session.archiveApplication({ restorePatch, unsupportedFiles });
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
        const syntax = commentSyntaxForFile(filePath);
        await rewriteConfinedText({
            root: args.projectRoot,
            file: filePath,
            skipNonRegular: true,
            transform: (content) => {
                const lines = content.split("\n");
                for (let h = fileHunks.length - 1; h >= 0; h--) {
                    const hunk = fileHunks[h];
                    if (!hunk) {
                        continue;
                    }
                    // Deleted files have no post-image to wrap; unapply restores their saved pre-image.
                    if (hunk.newLines === 0) {
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
                return lines.join("\n");
            },
        });
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
