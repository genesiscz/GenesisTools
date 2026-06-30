import { Database } from "bun:sqlite";
import { logger, out } from "@app/logger";
import chalk from "chalk";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";
import type { StashRow, VersionRow } from "../types";

const { log } = logger.scoped("stash:versions");

export async function versionsCommand(name: string): Promise<void> {
    log.debug({ name }, "versionsCommand");
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(name);
    if (!stash) {
        ui.err(`stash "${name}" not found`);
        db.close();
        process.exit(1);
    }
    const rows = db
        .query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC")
        .all(stash.id);
    log.debug({ stashId: stash.id, versionCount: rows.length }, "versions fetched");

    if (!rows.length) {
        ui.info("no versions");
        db.close();
        return;
    }

    // EVERYTHING to stdout in order — mixing stderr (ui.*) and stdout (out.*) makes the
    // terminal display rows before the section divider due to independent stream buffering.
    const title = `${name} — ${rows.length} version${rows.length === 1 ? "" : "s"}`;
    out.println(chalk.dim(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`));
    out.println(chalk.dim(`  VER  FILES  REGIONS  CREATED                       ORIGIN`));
    for (const r of rows) {
        const ver = `v${r.version}`.padEnd(4);
        const files = String(r.file_count).padStart(5);
        const regs = String(r.region_count).padStart(7);
        const created = r.created_at.padEnd(29);
        out.println(`  ${ver} ${files}  ${regs}  ${created} ${r.source_origin ?? "—"}`);
    }
    db.close();
}
