import type { Database } from "bun:sqlite";
import { logger } from "@app/logger";
import { newStashId } from "./ids";
import { parseRegionsFromPatch } from "./parse-regions";
import type { StashStorage } from "./storage";
import { StoreRepo } from "./store-repo";

const { log } = logger.scoped("stash:doctor");

export interface DoctorIssue {
    severity: "error" | "warn" | "info";
    category: "store" | "versions" | "applications" | "regions";
    message: string;
    /** Optional identifier for grep-able output (stash name, version id, etc.). */
    ref?: string;
}

export interface DoctorResult {
    issues: DoctorIssue[];
    healed: number; // count of rows fixed by --rebuild
}

export async function runDoctor(args: {
    db: Database;
    storage: StashStorage;
    rebuild: boolean;
}): Promise<DoctorResult> {
    const issues: DoctorIssue[] = [];
    let healed = 0;
    const repo = new StoreRepo(args.storage.storeRepoDir());

    // 1. Verify store-repo integrity via git fsck.
    try {
        const proc = Bun.spawn(["git", "--git-dir", args.storage.storeRepoDir(), "fsck", "--strict"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

        if (exit !== 0) {
            issues.push({ severity: "error", category: "store", message: `git fsck failed: ${stderr.trim()}` });
        }
    } catch (err) {
        issues.push({ severity: "error", category: "store", message: `git fsck unavailable: ${String(err)}` });
    }

    log.debug("store fsck complete");

    // 2. Every versions row must have a resolvable patch_ref in the store.
    const versions = args.db
        .query<{ id: string; stash_id: string; version: number; patch_ref: string }, []>(
            "SELECT id, stash_id, version, patch_ref FROM versions"
        )
        .all();

    for (const v of versions) {
        const sha = await repo.resolveRef(v.patch_ref);

        if (!sha) {
            issues.push({
                severity: "error",
                category: "versions",
                message: `versions.id=${v.id} (stash=${v.stash_id} v${v.version}) references missing store ref ${v.patch_ref}`,
                ref: v.id,
            });
        }
    }

    log.debug({ count: versions.length }, "versions refs checked");

    // 3. Active applications' version_id must resolve, and project_path must contain markers for the stash.
    const apps = args.db
        .query<{ id: string; stash_id: string; version_id: string | null; project_path: string }, []>(
            "SELECT id, stash_id, version_id, project_path FROM applications WHERE state = 'active'"
        )
        .all();

    for (const app of apps) {
        if (!app.version_id) {
            issues.push({
                severity: "warn",
                category: "applications",
                message: `applications.id=${app.id} is active but version_id is null (orphaned by drop)`,
                ref: app.id,
            });
            continue;
        }

        const v = args.db
            .query<{ version: number }, [string]>("SELECT version FROM versions WHERE id = ?")
            .get(app.version_id);

        if (!v) {
            issues.push({
                severity: "error",
                category: "applications",
                message: `applications.id=${app.id} references missing version ${app.version_id}`,
                ref: app.id,
            });
        }
    }

    log.debug({ count: apps.length }, "applications checked");

    // 4. --rebuild: regenerate regions table from stored patches. The async patch reads happen
    // outside the transaction so the DELETE + INSERT loop is atomic — a failure mid-rebuild
    // shouldn't leave the regions table half-empty.
    if (args.rebuild) {
        const rows: Array<[string, string, string | null, string, number, number, number]> = [];
        for (const v of versions) {
            const patch = (await repo.readFileAt(v.patch_ref, "PATCH.diff")) ?? "";
            for (const r of parseRegionsFromPatch(patch)) {
                rows.push([
                    newStashId(),
                    v.id,
                    r.regionName,
                    r.filePath,
                    r.hunkIndex,
                    r.startMarkerPresent ? 1 : 0,
                    r.lineCount,
                ]);
            }
        }

        const insertStmt = args.db.prepare(
            `INSERT INTO regions (id, version_id, region_name, file_path, hunk_index, start_marker_present, line_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        args.db.transaction(() => {
            args.db.run("DELETE FROM regions");
            for (const row of rows) {
                insertStmt.run(...row);
                healed++;
            }
        })();

        log.debug({ healed }, "regions rebuilt");
    }

    return { issues, healed };
}
