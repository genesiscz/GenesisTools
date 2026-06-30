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
    bootstrapUpdateWalk,
    emitNonTtyPrompt,
    executeUpdateDecisions,
    walkInteractive,
} from "../lib/walk-execute";
import type { StashRow } from "../types";

const { log } = logger.scoped("stash:update");

export interface UpdateOptions {
    name: string;
    decision?: string;
    action?: "start" | "continue" | "skip" | "abort" | "status";
}

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

    try {
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);

    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);

        process.exit(1);
    }

    const projectHash = createHash("sha256").update(project.rootPath).digest("hex");
    const action = opts.action ?? "start";

    // Non-start control actions (abort / status) — load existing walk only.
    if (action === "abort" || action === "status") {
        const w = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });

        if (w?.snapshot().verb !== "update") {
            ui[action === "abort" ? "warn" : "info"]("no in-progress update session");
    
            return;
        }

        if (action === "abort") {
            await w.abort();
            ui.ok("aborted");
        } else {
            const p = w.progress();
            ui.info(`${p.decided}/${p.total} decided`);
        }


        return;
    }

    // Start or continue — load existing session or bootstrap a new one.
    let walk = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });

    if (walk && walk.snapshot().verb !== "update") {
        ui.err(`in-progress ${walk.snapshot().verb} session blocks update; resolve it first`);

        process.exit(1);
    }

    if (!walk) {
        try {
            walk = await bootstrapUpdateWalk({ storage, db, stash, project, projectHash });
        } catch (err) {
            log.error({ error: err, stashId: stash.id, projectHash, action }, "bootstrapUpdateWalk failed");
            // Surface as a clean CLI error instead of a bun stack trace. Common case: stash isn't
            // applied here (`bootstrapUpdateWalk` throws Error with the recovery hint embedded).
            ui.err(err instanceof Error ? err.message : String(err));
    
            process.exit(1);
        }
    }

    // Apply incoming decision — blanket first, then per-region.
    applyBlanketDecision(walk, opts.decision);

    if (action === "skip" && walk.currentRegion()) {
        walk.decide("skip");
    } else if (opts.decision && !opts.decision.endsWith("-all-dangerous")) {
        const dec = (
            { capture: "capture", restore: "restore", skip: "skip" } as Record<string, "capture" | "restore" | "skip">
        )[opts.decision];

        if (dec && walk.currentRegion()) {
            walk.decide(dec);
        }
    }

    // Interactive walk in TTY.
    if (isInteractive() && !walk.isComplete()) {
        await walkInteractive({ walk, verb: "update" });
    }

    // If still incomplete (non-TTY or paused), persist and emit non-TTY prompt.
    if (!walk.isComplete()) {
        await walk.persist();
        await emitNonTtyPrompt({ walk, verb: "update" });

        return;
    }

    await executeUpdateDecisions({ walk, projectRoot: project.rootPath, storage, db, stash });
    await walk.complete();
    log.debug({ stashId: stash.id }, "update complete");
    } finally {
        db.close();
    }
}
