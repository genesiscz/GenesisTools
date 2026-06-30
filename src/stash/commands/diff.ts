import { Database } from "bun:sqlite";
import { logger, out } from "@app/logger";
import chalk from "chalk";
import { diffApplied } from "../lib/diff-applied";
import { detectProject } from "../lib/projects";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";

const { log } = logger.scoped("stash:diff");

export interface DiffOptions {
    name: string;
    at?: number;
}

export async function diffCommand(opts: DiffOptions): Promise<void> {
    log.debug({ opts }, "diffCommand");

    const project = await detectProject(process.cwd());

    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    try {
        const result = await diffApplied({
            name: opts.name,
            projectRoot: project.rootPath,
            db,
            storage,
            pinnedVersion: opts.at,
        });

        if (result.regions.length === 0) {
            ui.ok(`"${opts.name}" applied region matches stored content; no drift`);
            return;
        }

        // All output to stdout in one stream so the per-region divider appears BEFORE the diff
        // body it labels (mixing stderr ui.* with stdout out.* causes the diff body to print
        // first due to independent stream buffering).
        out.println(chalk.bold(`${opts.name} — ${result.regions.length} drifted region(s)`));
        for (const r of result.regions) {
            const title = `${r.filePath}:hunk-${r.hunkIndex}`;
            out.println("");
            out.println(chalk.dim(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`));
            out.print(r.diff);
        }

        // Close db BEFORE exiting — process.exit() does NOT unwind the stack, so the finally
        // block below won't run when this branch is hit. Explicit close releases the SQLite
        // handle deterministically (OS reclaims it anyway, but this is cleaner).
        db.close();
        process.exit(result.exitCode);
    } catch (err) {
        ui.err(err instanceof Error ? err.message : String(err));
        db.close();
        process.exit(1);
    }
}
