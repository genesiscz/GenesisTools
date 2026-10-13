import { setPriority } from "node:os";
import { logger } from "@genesiscz/utils/logger";
import { runDailyCompression } from "./daily";

/**
 * The daily compression pass as a process: started detached by the logger once per day (`logger/daily-trigger.ts`),
 * or by hand with `bun src/utils/compress/daily-pass.ts [<logs dir>]`. Runs at low priority.
 */
if (import.meta.main) {
    try {
        setPriority(process.pid, 15);
    } catch (err) {
        logger.debug({ err }, "[compress] could not lower the daily pass's priority");
    }

    await runDailyCompression({ logsDir: process.argv[2] });
}
