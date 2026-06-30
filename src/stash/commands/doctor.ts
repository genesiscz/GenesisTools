import { Database } from "bun:sqlite";
import { logger } from "@app/logger";
import { runDoctor } from "../lib/doctor";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";

const { log } = logger.scoped("stash:doctor");

export interface DoctorOptions {
    rebuild?: boolean;
}

export async function doctorCommand(opts: DoctorOptions): Promise<void> {
    log.debug({ opts }, "doctorCommand");
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    try {
        const result = await runDoctor({ db, storage, rebuild: !!opts.rebuild });

        if (result.issues.length === 0) {
            ui.ok("no issues found (checked store, versions, applications)");
            if (result.healed > 0) {
                ui.info(`  --rebuild: ${result.healed} region row${result.healed === 1 ? "" : "s"} regenerated`);
            }
            return;
        }

        ui.header(`${result.issues.length} issue(s) found:`);

        for (const issue of result.issues) {
            const fn = issue.severity === "error" ? ui.err : issue.severity === "warn" ? ui.warn : ui.info;
            fn(`[${issue.category}] ${issue.message}`);
        }

        if (opts.rebuild) {
            ui.ok(`--rebuild: ${result.healed} region rows regenerated`);
        }

        // Close db BEFORE exit — process.exit() doesn't unwind the stack, so the finally
        // wouldn't run. OS reclaims the handle anyway, but explicit is cleaner.
        const exitCode = result.issues.some((i) => i.severity === "error") ? 1 : 0;
        db.close();
        process.exit(exitCode);
    } catch (err) {
        db.close();
        throw err;
    }
}
