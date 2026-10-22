import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "@genesiscz/utils/env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { isTestProcess } from "@genesiscz/utils/test-process";

const PASS_SCRIPT = path.join(moduleDir(import.meta), "..", "compress", "daily-pass.ts");

/**
 * Starts the daily compression pass (old day logs and ai-proxy transcripts become `.zst`) at most once per day per log
 * folder, in a detached low-priority process, so no command waits on it. Called when the logger opens a day's file:
 * the common case costs one `existsSync` of the day's claim file. The claim is an exclusive create, so of several
 * processes starting together exactly one spawns the pass. Never in tests, never without Bun, and never with
 * `GENESIS_TOOLS_NO_DAILY_COMPRESS=1`. Returns whether it started the pass.
 */
export function startDailyCompressionOnce(logDir: string, today: string): boolean {
    if (!process.versions.bun || isTestProcess() || env.log.isDailyCompressionDisabled()) {
        return false;
    }

    const claim = path.join(logDir, `.daily-compress-${today}`);

    if (fs.existsSync(claim)) {
        return false;
    }

    try {
        fs.closeSync(fs.openSync(claim, "wx"));
    } catch {
        // EEXIST: another process claimed today first. Anything else: no pass today; logging stays unaffected.
        return false;
    }

    try {
        const child = spawn(process.execPath, [PASS_SCRIPT, logDir], { detached: true, stdio: "ignore" });
        child.on("error", (err) => process.stderr.write(`[logger] the daily compression pass did not start: ${err}\n`));
        child.unref();
        return true;
    } catch (err) {
        process.stderr.write(`[logger] the daily compression pass did not start: ${err}\n`);
        return false;
    }
}
