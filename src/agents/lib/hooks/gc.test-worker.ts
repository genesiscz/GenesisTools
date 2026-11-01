// One post phase sweeping abandoned captures, for hooks.test.ts: the post phases of a parallel batch run in separate
// processes, and only processes can show that one of them sweeps. Prints `swept` or `skipped`.
// argv: <data root> <stamp> <start at, epoch ms>
import { sweepAbandonedCaptures } from "./gc";

const [root, stamp, startAt] = process.argv.slice(2);

if (!root || !stamp || !startAt) {
    throw new Error("usage: gc.test-worker.ts <data root> <stamp> <start at>");
}

// Every worker starts at the same moment: process starts are spread over hundreds of milliseconds.
await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));

process.stdout.write(sweepAbandonedCaptures({ now: Date.now(), root, stamp }) ? "swept" : "skipped");
