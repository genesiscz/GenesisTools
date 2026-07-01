import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { logger } from "@app/logger";
import { isInteractive } from "@app/utils/cli";
import { detectProject } from "../lib/projects";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";
import { Walk } from "../lib/walk";
import {
    applyBlanketDecision,
    bootstrapUnapplyWalk,
    emitNonTtyPrompt,
    executeUnapplyDecisions,
    normalizeUnapplyDecision,
    processAutoRemoves,
    walkInteractive,
} from "../lib/walk-execute";
import type { StashRow } from "../types";

const { log } = logger.scoped("stash:unapply");

export interface UnapplyOptions {
    name: string;
    action: "start" | "continue" | "skip" | "abort" | "status";
    /**
     * v1.1 verbs: "capture" | "restore" | "skip"
     * v1 back-compat aliases: "update" → capture, "discard" → restore
     * Blanket dangerous forms: "discard-all-dangerous" | "update-stash-all-dangerous"
     */
    decision:
        | "capture"
        | "restore"
        | "skip"
        | "update"
        | "discard"
        | "discard-all-dangerous"
        | "update-stash-all-dangerous"
        | undefined;
}

export async function unapplyCommand(opts: UnapplyOptions): Promise<void> {
    log.debug({ opts }, "unapplyCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    try {
        const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
        if (!stash) {
            ui.err(`stash "${opts.name}" not found`);

            process.exit(1);
        }

        const projectHash = createHash("sha256").update(project.rootPath).digest("hex");

        // Fast paths: abort and status only need to load an existing walk.
        if (opts.action === "abort" || opts.action === "status") {
            const w = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
            if (!w) {
                ui.info("no in-progress session");

                return;
            }
            if (opts.action === "abort") {
                await w.abort();
                ui.ok("aborted");
            } else {
                const p = w.progress();
                const cur = w.currentRegion();
                ui.info(
                    `${p.decided}/${p.total} decided; current: ${cur?.filePath ?? "(none)"} hunk ${cur?.hunkIndex ?? "?"}`
                );
            }

            return;
        }

        // Load or bootstrap the walk.
        let walk = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!walk) {
            if (opts.action !== "start") {
                ui.err("no in-progress session; run without --continue to start");

                process.exit(1);
            }
            walk = await bootstrapUnapplyWalk({ storage, db, stash, project, projectHash });
            if (!walk) {
                return;
            }
            // Only strip unchanged regions on the first run (not on --continue) to keep logs clean.
            await processAutoRemoves({ walk, projectRoot: project.rootPath });
        }

        // Apply incoming decision (normalise v1 aliases → v1.1 verbs at the CLI boundary).
        applyBlanketDecision(walk, opts.decision);
        const d = normalizeUnapplyDecision(opts.decision);
        if (d && walk.currentRegion()) {
            walk.decide(d);
        } else if (opts.action === "skip" && walk.currentRegion()) {
            walk.decide("skip");
        }

        if (isInteractive() && !walk.isComplete()) {
            await walkInteractive({ walk, verb: "unapply" });
        }

        if (!walk.isComplete()) {
            await walk.persist();
            await emitNonTtyPrompt({ walk, verb: "unapply" });

            return;
        }

        const stats = await executeUnapplyDecisions({ walk, projectRoot: project.rootPath, storage, db, stash });

        // D-25: only mark the application 'unapplied' when every region was cleaned up. A
        // marker-missing outcome means the user's file may still carry wrapped code; keeping the
        // application 'active' preserves the retry path.
        if (stats.failedToFind === 0) {
            const now = new Date().toISOString();
            db.run(
                "UPDATE applications SET state = 'unapplied', unapplied_at = ? WHERE stash_id = ? AND project_path = ? AND state = 'active'",
                [now, stash.id, project.rootPath]
            );
            await walk.complete();
            ui.ok(
                `unapplied "${opts.name}" — ${stats.removed} removed, ${stats.updated} captured to v${stats.newVersion ?? "(none)"}, ${stats.skipped} skipped`
            );
        } else {
            await walk.persist();
            ui.err(`partial unapply: ${stats.failedToFind} region(s) had no matching marker; application kept ACTIVE`);
            for (const f of stats.failedFiles) {
                ui.warn(`  marker missing in: ${f}`);
            }
            ui.info(
                "either restore the missing markers manually and re-run 'unapply --continue', or 'unapply --abort' to discard the session"
            );
        }

        log.debug({ stashId: stash.id, stats }, "stash unapplied");
    } finally {
        db.close();
    }
}
