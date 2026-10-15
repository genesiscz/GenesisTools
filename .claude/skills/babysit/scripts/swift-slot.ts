#!/usr/bin/env bun
/**
 * Run one heavy Swift command in the Mac's single Swift slot.
 *
 *   bun swift-slot.ts [--wait-minutes 40] -- swift test --package-path src/macos/GenesisKit --filter Foo
 *
 * A process check alone races: two waiters that poll the process list both see a free slot in the same second and
 * start together (two judge runs on 2026-10-15). So the slot is a lock file created with O_EXCL, and the holder also
 * waits until no Swift build of another session (one that does not use this lock) is running. The lock names its pid;
 * a lock whose pid is gone is taken over. Exits with the command's own status, 124 when the wait ran out.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProcesses } from "@genesiscz/utils/process/processes";

const LOCK = join(tmpdir(), "genesis-swift-slot.lock");
const SWIFT = new Set(["swift-build", "swift-test", "swift-package", "swift-frontend", "xctest"]);

const args = process.argv.slice(2);
// `bun swift-slot.ts -- swift …` reaches here without the `--`: bun takes a separator that directly follows the
// script as its own. So the command is everything after `--` when one is left, else everything after the options.
const waitFlag = args.indexOf("--wait-minutes");
const waitMinutes = waitFlag === -1 ? 40 : Number(args[waitFlag + 1]);
const split = args.indexOf("--");
const command = split !== -1 ? args.slice(split + 1) : args.slice(waitFlag === 0 ? 2 : 0);

if (command.length === 0) {
    console.error("usage: bun swift-slot.ts [--wait-minutes N] -- <command…>");
    process.exit(2);
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function tryLock(): boolean {
    try {
        const fd = openSync(LOCK, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return true;
    } catch {
        const holder = Number.parseInt(readFileSync(LOCK, "utf8").trim(), 10);

        if (Number.isFinite(holder) && !alive(holder)) {
            unlinkSync(LOCK);
            return tryLock();
        }

        return false;
    }
}

/** A Swift build of any session, read from the kernel's process table (the process layer, no `ps`). */
function swiftRunning(): boolean {
    return listProcesses().some((entry) => SWIFT.has(entry.name));
}

function release(): void {
    try {
        if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) {
            unlinkSync(LOCK);
        }
    } catch {
        // Already gone.
    }
}

const deadline = Date.now() + waitMinutes * 60_000;

while (!tryLock()) {
    if (Date.now() > deadline) {
        console.error(`swift-slot: lock ${LOCK} still held after ${waitMinutes} min`);
        process.exit(124);
    }

    await Bun.sleep(5000);
}

process.on("exit", release);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        release();
        process.exit(130);
    });
}

while (swiftRunning()) {
    if (Date.now() > deadline) {
        console.error(`swift-slot: another Swift build still running after ${waitMinutes} min`);
        process.exit(124);
    }

    await Bun.sleep(10_000);
}

const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
