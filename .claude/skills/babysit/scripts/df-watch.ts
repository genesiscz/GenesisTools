#!/usr/bin/env bun
/**
 * Check free disk every 5 minutes and exit when it drops below the threshold, waking the lead once.
 * Exits 0 for low space, 124 when its finite lifetime expires, 1 for an unreadable query and 2 for invalid options.
 *
 *   bun df-watch.ts [--below-gb 5] [--volume /System/Volumes/Data] [--for 30]
 * --for is the maximum lifetime in minutes, including each bounded df query and the last sleep.
 */
import { flag, has } from "./run";

const belowGb = Number(flag("--below-gb") ?? 5);
const rawLifetime = flag("--for");
const lifetimeMinutes = Number(rawLifetime ?? 30);
const deadline = Date.now() + lifetimeMinutes * 60_000;
const volume = flag("--volume") ?? (process.platform === "darwin" ? "/System/Volumes/Data" : "/");
if (
    !Number.isFinite(belowGb) ||
    belowGb < 0 ||
    !Number.isFinite(lifetimeMinutes) ||
    lifetimeMinutes < 0 ||
    !Number.isFinite(deadline) ||
    (has("--for") && (rawLifetime === undefined || rawLifetime.trim() === ""))
) {
    console.error("df-watch: --below-gb and --for must be finite nonnegative numbers");
    process.exit(2);
}

const stamp = () => new Date().toLocaleTimeString("cs-CZ", { timeZone: "Europe/Prague" });
function expired(): never {
    console.log(`${stamp()} disk watch expired after ${lifetimeMinutes} min`);
    process.exit(124);
}

function freeGb(): number {
    const result = Bun.spawnSync(["df", "-k", volume], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: Math.max(1, Math.min(30_000, deadline - Date.now())),
    });
    if (result.exitCode !== 0) {
        throw new Error(`df exited ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 160)}`);
    }

    const columns = result.stdout.toString().trim().split("\n").at(-1)?.split(/\s+/) ?? [];
    const free = Number(columns[3]) / 1024 / 1024;
    if (!Number.isFinite(free) || free < 0) {
        throw new Error(`df gave no number for ${volume}`);
    }
    return free;
}

let first = true;
while (Date.now() < deadline) {
    let free: number;
    try {
        free = freeGb();
    } catch (error) {
        if (Date.now() >= deadline) {
            expired();
        }
        console.log(`${stamp()} ${String(error)}: stopping so the lead notices`);
        process.exit(1);
    }

    if (Date.now() >= deadline) {
        expired();
    }

    if (first) {
        console.log(
            `${stamp()} watching ${volume}: ${free.toFixed(1)} GB free, wake below ${belowGb} GB; lifetime ${lifetimeMinutes} min`
        );
        first = false;
    }

    if (free < belowGb) {
        console.log(`${stamp()} LOW DISK: ${free.toFixed(2)} GB free (threshold ${belowGb} GB)`);
        process.exit(0);
    }

    await Bun.sleep(Math.min(300_000, Math.max(0, deadline - Date.now())));
}
expired();
