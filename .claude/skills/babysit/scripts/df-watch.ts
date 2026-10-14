#!/usr/bin/env bun
/**
 * Checks free disk every 5 minutes and EXITS when it drops below the threshold, so a lead that runs it with Bash
 * run_in_background is woken exactly once, in time to run tmp-reclaim.ts. Never a poll in the lead's own turn.
 *
 *   bun df-watch.ts [--below-gb 5] [--volume /System/Volumes/Data]
 */
import { flag } from "./run";

const belowGb = Number(flag("--below-gb") ?? 5);
const volume = flag("--volume") ?? (process.platform === "darwin" ? "/System/Volumes/Data" : "/");

function freeGb(): number {
    const out = Bun.spawnSync(["df", "-k", volume], { stdout: "pipe" }).stdout.toString();
    const columns = out.trim().split("\n").at(-1)?.split(/\s+/) ?? [];
    return Number(columns[3]) / 1024 / 1024;
}

const stamp = () => new Date().toLocaleTimeString("cs-CZ", { timeZone: "Europe/Prague" });
console.log(`${stamp()} watching ${volume}: ${freeGb().toFixed(1)} GB free, wake below ${belowGb} GB`);

while (true) {
    const free = freeGb();

    if (!Number.isFinite(free)) {
        console.log(`${stamp()} df gave no number for ${volume}: stopping so the lead notices`);
        process.exit(1);
    }

    if (free < belowGb) {
        console.log(`${stamp()} LOW DISK: ${free.toFixed(2)} GB free (threshold ${belowGb} GB)`);
        process.exit(0);
    }

    await Bun.sleep(300_000);
}
