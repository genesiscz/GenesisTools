import { Database } from "bun:sqlite";
import { logger, out } from "@app/logger";
import chalk from "chalk";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";
import type { ApplicationRow, StashRow } from "../types";

const { log } = logger.scoped("stash:where");

export async function whereCommand(name: string): Promise<void> {
    log.debug({ name }, "whereCommand");
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(name);
    if (!stash) {
        ui.err(`stash "${name}" not found`);
        db.close();
        process.exit(1);
    }
    const apps = db
        .query<ApplicationRow, [string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND state = 'active' ORDER BY applied_at"
        )
        .all(stash.id);
    log.debug({ stashId: stash.id, applicationCount: apps.length }, "active applications fetched");

    if (!apps.length) {
        ui.info("not currently applied anywhere");
        db.close();
        return;
    }

    // All output to stdout in one stream so interactive display order matches code order
    // (mixing stderr ui.* with stdout out.* causes the terminal to reorder them).
    const title = `${name} — ${apps.length} active application${apps.length === 1 ? "" : "s"}`;
    const pathW = Math.max(10, ...apps.map((a) => a.project_path.length));
    out.println(chalk.dim(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`));
    out.println(chalk.dim(`  ${"PROJECT".padEnd(pathW)}  APPLIED`));
    for (const a of apps) {
        out.println(`  ${a.project_path.padEnd(pathW)}  ${a.applied_at}`);
    }
    db.close();
}
