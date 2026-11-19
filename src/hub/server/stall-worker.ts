import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workerData } from "node:worker_threads";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { HEARTBEAT_MS, stallObserver } from "./stall-watch";

const { beats, socketPath }: { beats: Int32Array; socketPath: string } = workerData;
const observe = stallObserver();
const pid = process.pid;

async function capture(lagMs: number): Promise<void> {
    const at = new Date().toISOString();
    logger.warn({ pid, at, lagMs }, "hub server event loop missed its heartbeat");
    if (process.platform !== "darwin") {
        return;
    }

    // The server owns this 0700 directory. Keep the latest successful stack across restarts.
    const file = join(dirname(socketPath), "last-stall.sample.txt");
    const pending = `${file}.${pid}.tmp`;
    try {
        const result = await boundedCommand({
            command: ["/usr/bin/sample", String(pid), "2", "-file", pending],
            timeoutMs: 10_000,
        });
        if (result.error || result.status !== 0) {
            throw new Error(result.error?.message ?? (result.stderr.trim() || `sample exited ${result.status}`));
        }
        await rename(pending, file);
    } catch (error) {
        await unlink(pending).catch((cleanupError) => {
            logger.debug({ cleanupError, pending }, "Pending stall sample cleanup");
        });
        throw error;
    }

    logger.warn({ pid, at, lagMs, file }, "hub server stall sample saved");
}

setInterval(() => {
    const lagMs = observe(Atomics.load(beats, 0), performance.now());
    if (lagMs !== null) {
        void capture(lagMs).catch((error) => logger.warn({ pid, lagMs, error }, "hub server stall sample failed"));
    }
}, HEARTBEAT_MS);
