import { Database } from "bun:sqlite";
import { logger } from "@app/logger";
import { detectProject } from "../lib/projects";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";
import type { ApplicationRow, StashRow } from "../types";
import { saveCommand } from "./save";

const { log } = logger.scoped("stash:update");

export interface UpdateOptions {
    name: string;
    mode: "all" | "staged" | "unstaged";
}

/**
 * Capture the current working tree as a new version of an already-applied stash.
 *
 * v1 semantics: requires an active application of <name> in cwd, then delegates to saveCommand
 * (auto-bumps to vN+1). The diff captures the full working tree, not only marker-bounded regions
 * — broader than spec §7.5 but more useful in practice (edits often span outside the stash region).
 * Spec-strict region-scoped capture is deferred to v1.1.
 */
export async function updateCommand(opts: UpdateOptions): Promise<void> {
    log.debug({ opts }, "updateCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);
        db.close();
        process.exit(1);
    }

    const active = db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(stash.id, project.rootPath);
    if (!active) {
        ui.err(`"${opts.name}" is not applied here — use 'save' to create a new stash, or 'apply' first`);
        db.close();
        process.exit(1);
    }
    log.debug(
        { stashId: stash.id, projectPath: project.rootPath, currentVersion: active.version_id },
        "update precondition passed"
    );
    db.close();

    await saveCommand({ name: opts.name, mode: opts.mode, tags: [], description: undefined });
}
