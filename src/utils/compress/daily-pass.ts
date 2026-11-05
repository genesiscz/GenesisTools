import { setPriority } from "node:os";
import { logger } from "@genesiscz/utils/logger";
import { loadRmConfig } from "@genesiscz/utils/rm/config";
import { keepDiskReserve } from "@genesiscz/utils/rm/disk-reserve";
import { refreshWaitingRmData } from "@genesiscz/utils/rm/keepalive";
import { runDailyCompression } from "./daily";

/**
 * The daily pass as a process: started detached by the logger once per day (`logger/daily-trigger.ts`), or by hand
 * with `bun src/utils/compress/daily-pass.ts [<logs dir>]`. Runs at low priority. It refreshes the files `tools rm`
 * keeps in /tmp against macOS tmp_cleaner and makes its disk reserve, then compresses the finished day logs and
 * transcripts.
 */
if (import.meta.main) {
    try {
        setPriority(process.pid, 15);
    } catch (err) {
        logger.debug({ err }, "[compress] could not lower the daily pass's priority");
    }

    // First, and on its own: a failed compression must not skip it, and it takes seconds where the compression can
    // take minutes. The pass is the runner because the first logging process of each local day starts it.
    try {
        refreshWaitingRmData();
    } catch (err) {
        logger.warn({ err }, "[compress] the rm keepalive failed");
    }

    // The space `tools rm` gives back on a full disk, so it can still record a deletion there.
    try {
        keepDiskReserve({ megabytes: loadRmConfig().diskReserveMB });
    } catch (err) {
        logger.warn({ err }, "[compress] the rm disk reserve could not be made");
    }

    await runDailyCompression({ logsDir: process.argv[2] });
}
