// One caller of `singleFlight` in its own process, for single-flight.test.ts: the lock and the answer must work across
// processes, which promises in one test process cannot show.
// argv: <dir> <key> <runs file> <run ms> <ttl ms> <start at, epoch ms>
import { appendFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { singleFlight } from "./single-flight";

const [dir, key, runsPath, runMs, ttlMs, startAt] = process.argv.slice(2);

if (!dir || !key || !runsPath || !runMs || !ttlMs || !startAt) {
    throw new Error("usage: single-flight.test-worker.ts <dir> <key> <runs file> <run ms> <ttl ms> <start at>");
}

// Every worker starts its call at the same moment: process starts are spread over hundreds of milliseconds.
await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));

const value = await singleFlight({
    key,
    dir,
    ttlMs: Number(ttlMs),
    run: async () => {
        appendFileSync(runsPath, `${process.pid}\n`);
        await Bun.sleep(Number(runMs));
        return { by: process.pid, text: "žluťoučký kůň 🐎" };
    },
});

process.stdout.write(SafeJSON.stringify(value, { strict: true }));
