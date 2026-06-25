import { Database } from "bun:sqlite";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import { detectProject, findSiblingClones } from "../lib/projects";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";
import type { StashRow } from "../types";

const { log } = logger.scoped("stash:list");

export interface ListOptions {
    project: boolean;
    tag: string | undefined;
    applied: boolean;
}

export async function listCommand(opts: ListOptions): Promise<void> {
    log.debug({ opts }, "listCommand");
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    let projectPaths: string[] | null = null;
    if (opts.project || opts.applied) {
        const project = await detectProject(process.cwd());
        if (!project) {
            ui.err("--project / --applied require a git repo");
            db.close();
            process.exit(1);
        }
        const siblings = await findSiblingClones(project.rootPath);
        projectPaths = [project.rootPath, ...siblings];
        log.debug({ rootPath: project.rootPath, siblings: siblings.length }, "project scope resolved");
    }

    let rows: StashRow[];
    if (opts.applied && projectPaths) {
        // --applied: STRICTLY return only stashes with an active application in the project scope.
        // (--project alone also matches `source_repo_path`, so a stash saved here but never applied still shows.)
        const placeholders = projectPaths.map(() => "?").join(",");
        rows = db
            .query<StashRow, string[]>(
                `SELECT DISTINCT s.* FROM stashes s
                 JOIN applications a ON a.stash_id = s.id
                 WHERE a.state = 'active' AND a.project_path IN (${placeholders})
                 ORDER BY s.updated_at DESC`
            )
            .all(...projectPaths);
    } else if (projectPaths) {
        // --project: any stash either applied to this scope OR saved from this scope.
        const placeholders = projectPaths.map(() => "?").join(",");
        rows = db
            .query<StashRow, string[]>(
                `SELECT DISTINCT s.* FROM stashes s
                 LEFT JOIN applications a ON a.stash_id = s.id AND a.state = 'active'
                 LEFT JOIN versions v ON v.stash_id = s.id
                 WHERE a.project_path IN (${placeholders}) OR v.source_repo_path IN (${placeholders})
                 ORDER BY s.updated_at DESC`
            )
            .all(...projectPaths, ...projectPaths);
    } else {
        rows = db.query<StashRow, []>("SELECT * FROM stashes ORDER BY updated_at DESC").all();
    }
    log.debug({ rowCount: rows.length, projectScoped: projectPaths !== null }, "stashes fetched");

    if (opts.tag) {
        const tag = opts.tag;
        const before = rows.length;
        rows = rows.filter((r) => {
            if (!r.tags) {
                return false;
            }
            const tags = SafeJSON.parse(r.tags) as string[];
            return tags.includes(tag);
        });
        log.debug({ tag, before, after: rows.length }, "tag filter applied");
    }

    if (!rows.length) {
        ui.info("no stashes");
        db.close();
        return;
    }

    // Build aligned rows: NAME (left, padded to longest) | VER | TAGS | STATUS
    interface DisplayRow {
        name: string;
        ver: string;
        tags: string;
        appliedHere: boolean;
    }
    const display: DisplayRow[] = rows.map((r) => {
        const v = db
            .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
            .get(r.id);
        const appliedHere = projectPaths
            ? (db
                  .query<{ c: number }, string[]>(
                      `SELECT COUNT(*) as c FROM applications WHERE stash_id = ? AND state = 'active' AND project_path IN (${projectPaths.map(() => "?").join(",")})`
                  )
                  .get(r.id, ...projectPaths)?.c ?? 0) > 0
            : false;
        return {
            name: r.name,
            ver: `v${v?.m ?? "?"}`,
            tags: r.tags ? (SafeJSON.parse(r.tags) as string[]).join(",") : "",
            appliedHere,
        };
    });

    const nameW = Math.max(4, ...display.map((d) => d.name.length));
    const verW = Math.max(3, ...display.map((d) => d.ver.length));
    const tagsW = Math.max(4, ...display.map((d) => d.tags.length));

    ui.section(`${rows.length} stash${rows.length === 1 ? "" : "es"}`);
    ui.dim(`  ${"NAME".padEnd(nameW)}  ${"VER".padEnd(verW)}  ${"TAGS".padEnd(tagsW)}  STATUS`);
    for (const d of display) {
        const status = d.appliedHere ? chalk.green("● applied here") : chalk.dim("·");
        // Plain row data via out.print so `tools stash list | grep` still works as expected.
        out.print(`  ${d.name.padEnd(nameW)}  ${d.ver.padEnd(verW)}  ${d.tags.padEnd(tagsW)}  ${status}`);
    }
    db.close();
}
