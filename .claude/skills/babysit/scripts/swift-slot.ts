#!/usr/bin/env bun
/**
 * Run one heavy Swift command in the Mac's single Swift slot.
 *
 *   bun swift-slot.ts [--wait-minutes 40] -- swift test --package-path src/macos/GenesisKit --filter Foo
 *
 * A process check alone races: two waiters that poll the process list both see a free slot in the same second and
 * start together (two judge runs on 2026-10-15). So the slot is a kernel file lock, and the holder also
 * waits until no Swift build of another session (one that does not use this lock) is running. The kernel releases
 * ownership when the holder exits, without deleting the lock file. Exits with the command's status, 124 on timeout.
 */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProcesses } from "@genesiscz/utils/process/processes";

const LOCK = join(tmpdir(), "genesis-swift-slot.lock");
const SWIFT = new Set(["swift-build", "swift-test", "swift-package", "swift-frontend", "xctest"]);

async function main(): Promise<void> {
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

    let release: (() => void) | null = null;

    /** A Swift build of any session, read from the kernel's process table (the process layer, no `ps`). */
    function swiftRunning(): boolean {
        return listProcesses().some((entry) => SWIFT.has(entry.name));
    }

    const deadline = Date.now() + waitMinutes * 60_000;

    release = trySwiftSlot(LOCK);

    while (!release) {
        if (Date.now() > deadline) {
            console.error(`swift-slot: lock ${LOCK} still held after ${waitMinutes} min`);
            process.exit(124);
        }

        await Bun.sleep(5000);
        release = trySwiftSlot(LOCK);
    }

    process.on("exit", () => release?.());

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            release?.();
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
}

/** Kernel ownership survives concurrent contenders and is released on process exit. Never unlink the lock inode. */
export function trySwiftSlot(lock: string): (() => void) | null {
    const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const fd = openSync(lock, "a+");

    // LOCK_EX | LOCK_NB on macOS and Linux. A dead owner has no kernel lock to steal.
    if (libc.symbols.flock(fd, 2 | 4) !== 0) {
        closeSync(fd);
        libc.close();
        return null;
    }

    let released = false;
    return () => {
        if (!released) {
            released = true;
            closeSync(fd);
            libc.close();
        }
    };
}

if (import.meta.main) {
    await main();
}
