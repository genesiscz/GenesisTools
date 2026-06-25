import { Database } from "bun:sqlite";
import { logger } from "@app/logger";
import { isInteractive } from "@app/utils/cli";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { StoreRepo } from "../lib/store-repo";
import { ui } from "../lib/ui";
import type { StashRow, VersionRow } from "../types";

const { log } = logger.scoped("stash:drop");

export async function dropCommand(opts: {
    name: string;
    version?: number;
    allVersions: boolean;
    orphanActive: boolean;
}): Promise<void> {
    log.debug({ opts }, "dropCommand");
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);
        db.close();
        process.exit(1);
    }

    const activeCount =
        db
            .query<{ c: number }, [string]>(
                "SELECT COUNT(*) as c FROM applications WHERE stash_id = ? AND state = 'active'"
            )
            .get(stash.id)?.c ?? 0;
    log.debug({ stashId: stash.id, activeCount }, "active application scan");
    if (activeCount > 0 && !opts.orphanActive) {
        ui.err(`${activeCount} active application(s) — pass --orphan-active to proceed`);
        db.close();
        process.exit(1);
    }

    if (opts.allVersions && opts.version !== undefined) {
        ui.err("--all-versions cannot be combined with --at");
        db.close();
        process.exit(1);
    }

    if (isInteractive()) {
        const { confirm } = await import("@clack/prompts");
        const ok = await confirm({
            message: `delete stash "${opts.name}"${opts.allVersions ? " (all versions)" : opts.version ? ` v${opts.version}` : " (latest)"}?`,
        });
        if (ok !== true) {
            ui.warn("cancelled");
            db.close();
            return;
        }
    }

    const repo = new StoreRepo(storage.storeRepoDir());
    let versionsToDelete: VersionRow[];
    if (opts.allVersions) {
        versionsToDelete = db.query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ?").all(stash.id);
    } else if (opts.version) {
        const v = db
            .query<VersionRow, [string, number]>("SELECT * FROM versions WHERE stash_id = ? AND version = ?")
            .get(stash.id, opts.version);
        versionsToDelete = v ? [v] : [];
    } else {
        const v = db
            .query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1")
            .get(stash.id);
        versionsToDelete = v ? [v] : [];
    }
    log.debug(
        { stashId: stash.id, count: versionsToDelete.length, orphanActive: opts.orphanActive },
        "destructive drop starting"
    );

    // PR #222 t25: an explicit `--at v` for a non-existent version must NOT proceed into the
    // BEGIN block — otherwise `--orphan-active` would still flip every active application to
    // 'orphaned' even though no version was dropped.
    if (opts.version && versionsToDelete.length === 0) {
        ui.err(`stash "${opts.name}" has no v${opts.version}`);
        db.close();
        process.exit(1);
    }

    // Wrap the destructive sequence in a SQLite transaction so a half-failure rolls back the DB
    // side. Store-repo ref deletes happen alongside (no transactional join with git), but
    // deleteRef is missing-safe (it logs+ignores already-absent refs), so a retry converges.
    // Orphan FIRST: flip application state to 'orphaned' so the audit row survives. The FK is
    // now ON DELETE SET NULL (PR #222 t21), so deleting versions also nulls version_id; this
    // explicit flip preserves the user-visible state transition.
    db.run("BEGIN");
    try {
        if (opts.orphanActive) {
            db.run("UPDATE applications SET state = 'orphaned' WHERE stash_id = ? AND state = 'active'", [stash.id]);
        }

        for (const v of versionsToDelete) {
            await repo.deleteRef(v.patch_ref);
            await repo.deleteRef(`refs/baselines/${stash.id}/v${v.version}`);
            db.run("DELETE FROM versions WHERE id = ?", [v.id]);
            log.debug({ version: v.version, patch_ref: v.patch_ref }, "version dropped");
        }

        const remaining =
            db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM versions WHERE stash_id = ?").get(stash.id)
                ?.c ?? 0;
        if (remaining === 0) {
            db.run("DELETE FROM stashes WHERE id = ?", [stash.id]);
            log.debug({ stashId: stash.id, name: stash.name }, "stash row dropped (no remaining versions)");
        }
        db.run("COMMIT");
    } catch (err) {
        try {
            db.run("ROLLBACK");
        } catch (rollbackErr) {
            // SQLite often auto-rolls-back after DDL/constraint failure; the explicit ROLLBACK then
            // throws "cannot rollback - no transaction is active". Log it so a genuinely failing
            // rollback (lock contention, etc.) isn't invisible.
            log.debug({ err: rollbackErr, stashId: stash.id }, "rollback after drop error failed (often benign)");
        }
        db.close();
        throw err;
    }

    ui.ok(`dropped ${versionsToDelete.length} version(s)`);
    db.close();
}
