#!/usr/bin/env bun
/**
 * Run one heavy Swift command in the Mac's single Swift slot.
 *
 *   bun swift-slot.ts [--wait-minutes 40] [--run-minutes 60] -- swift test --package-path src/macos/GenesisKit --filter Foo
 *
 * --wait-minutes bounds queueing; --run-minutes separately bounds the child after it acquires the slot.
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
import { killProcessGroup } from "@genesiscz/utils/process/killWithEscalation";
import { listProcesses } from "@genesiscz/utils/process/processes";

const LOCK = join(tmpdir(), "genesis-swift-slot.lock");
const SWIFT = new Set(["swift-build", "swift-test", "swift-package", "swift-frontend", "xctest"]);

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    // `bun swift-slot.ts -- swift …` reaches here without the `--`: bun takes a separator that directly follows the
    // script as its own. So the command is everything after `--` when one is left, else everything after the options.
    let waitMinutes = 40;
    let runMinutes = 60;
    let offset = 0;
    while (["--wait-minutes", "--run-minutes"].includes(args[offset])) {
        const minutes = Number(args[offset + 1]);
        if (args[offset] === "--wait-minutes") {
            waitMinutes = minutes;
        } else {
            runMinutes = minutes;
        }
        offset += 2;
    }
    const command = args.slice(offset + (args[offset] === "--" ? 1 : 0));

    if (
        command.length === 0 ||
        !Number.isFinite(waitMinutes) ||
        waitMinutes < 0 ||
        !Number.isFinite(Date.now() + waitMinutes * 60_000) ||
        !Number.isFinite(runMinutes) ||
        runMinutes < 0 ||
        !Number.isFinite(Date.now() + runMinutes * 60_000)
    ) {
        console.error(
            "usage: bun swift-slot.ts [--wait-minutes N] [--run-minutes N] -- <command…> (finite nonnegative minutes)"
        );
        process.exit(2);
    }

    let release: (() => void) | null = null;

    /** A Swift build of any session, read from the kernel's process table (the process layer, no `ps`). */
    function swiftRunning(): boolean {
        return listProcesses().some((entry) => SWIFT.has(entry.name));
    }

    const deadline = Date.now() + waitMinutes * 60_000;

    process.on("exit", () => release?.());
    function checkQueueDeadline(): void {
        if (Date.now() >= deadline) {
            console.error(`swift-slot: queue deadline expired after ${waitMinutes} min`);
            process.exit(124);
        }
    }

    checkQueueDeadline();
    release = trySwiftSlot(LOCK);
    checkQueueDeadline();
    while (!release) {
        checkQueueDeadline();
        await Bun.sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
        checkQueueDeadline();
        release = trySwiftSlot(LOCK);
        // Even an acquisition that returns after expiry must release its lock, without starting the child.
        checkQueueDeadline();
    }

    let forwardSignal = (signal: "SIGINT" | "SIGTERM"): void => {
        // No child while waiting for another session: exit releases only our own slot.
        process.exit(signal === "SIGINT" ? 130 : 143);
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => forwardSignal(signal));
    }

    while (swiftRunning()) {
        checkQueueDeadline();
        await Bun.sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
        checkQueueDeadline();
    }

    checkQueueDeadline();
    const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"], detached: true });
    let interruptedExit: number | null = null;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    forwardSignal = (signal) => {
        if (interruptedExit !== null) {
            return;
        }
        interruptedExit = signal === "SIGINT" ? 130 : 143;
        killProcessGroup(child, signal, "Swift slot child");
        forceKill = setTimeout(() => killProcessGroup(child, "SIGKILL", "Swift slot child"), 5000);
        forceKill.unref();
    };
    const runDeadline = Date.now() + runMinutes * 60_000;
    let timedOut = false;
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    const checkRunDeadline = () => {
        const remaining = runDeadline - Date.now();
        if (remaining > 0) {
            runTimer = setTimeout(checkRunDeadline, Math.min(remaining, 2_147_483_647));
            runTimer.unref();
            return;
        }
        timedOut = true;
        console.error(`swift-slot: run deadline exceeded after ${runMinutes} min; killing child group`);
        killProcessGroup(child, "SIGKILL", "Swift slot run deadline");
    };
    checkRunDeadline();
    const code = await child.exited;
    clearTimeout(forceKill);
    clearTimeout(runTimer);
    // Only now may the exit handler release the lock: forwarding a signal does not mean the child has stopped.
    process.exit(timedOut ? 124 : (interruptedExit ?? code));
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
