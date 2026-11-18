import { Worker } from "node:worker_threads";
import { logger } from "@genesiscz/utils/logger";

export const HEARTBEAT_MS = 1000;
const STALL_MS = 10_000;
const CAPTURE_INTERVAL_MS = 60_000;

/** The observer must itself have been running throughout the silence (the whole Mac can sleep). */
export function stallObserver() {
    let lastBeat: number | undefined;
    let lastCheck = 0;
    let since = 0;
    let captured = false;
    let nextCapture = 0;
    return (beat: number, now: number): number | null => {
        if (beat !== lastBeat || now - lastCheck > 2 * HEARTBEAT_MS) {
            since = now;
            captured = false;
        }

        lastBeat = beat;
        lastCheck = now;
        const lagMs = now - since;
        if (captured || lagMs < STALL_MS || now < nextCapture) {
            return null;
        }

        captured = true;
        nextCapture = now + CAPTURE_INTERVAL_MS;
        return lagMs;
    };
}

/** Keep the socket thread's heartbeat independent of the thread that diagnoses a missed beat. */
export function watchHubStalls(socketPath: string): () => void {
    const beats = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(new URL("./stall-worker.ts", import.meta.url), { workerData: { beats, socketPath } });
    const timer = setInterval(() => Atomics.add(beats, 0, 1), HEARTBEAT_MS);
    timer.unref();
    worker.on("error", (error) => logger.warn({ error }, "hub server stall watcher failed"));
    worker.on("exit", () => clearInterval(timer));
    worker.unref();
    return () => {
        clearInterval(timer);
        void worker.terminate();
    };
}
