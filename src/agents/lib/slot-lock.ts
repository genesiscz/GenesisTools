import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { sweepStaleLocks } from "@app/utils/storage/stale-lock-sweep";
import { appendFeed } from "./feed";
import { assertSafePathSegment } from "./paths";
import type { SessionPaths, SlotLockPayload } from "./types";

const log = logger.child({ component: "agents:slot-lock" });

export function slotLockPath(paths: SessionPaths, owner: string): string {
    assertSafePathSegment(owner, "owner");
    return join(paths.slotsDir, `${owner}.login`);
}

export function tryAcquireSlot(lockPath: string, payload: SlotLockPayload): boolean {
    const dir = dirname(lockPath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    try {
        writeFileSync(lockPath, SafeJSON.stringify(payload, { strict: true }), { flag: "wx" });
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;

        if (code === "EEXIST") {
            return false;
        }

        throw err;
    }
}

export function releaseSlot(lockPath: string): void {
    try {
        unlinkSync(lockPath);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;

        if (code !== "ENOENT") {
            log.warn({ lockPath, err }, "failed to release slot lock");
        }
    }
}

export function readSlotPayload(lockPath: string): SlotLockPayload | null {
    if (!existsSync(lockPath)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(lockPath, "utf8")) as SlotLockPayload;
    } catch {
        return null;
    }
}

export async function runStaleSweep(paths: SessionPaths): Promise<void> {
    const report = sweepStaleLocks(paths.slotsDir);

    for (const reaped of report.reaped) {
        await appendFeed(paths, {
            type: "stale_lock_reaped",
            lock: reaped.lock,
            pid: reaped.pid,
            reason: reaped.reason,
        });

        const owner = String(reaped.payload.owner ?? "");
        const kind = reaped.payload.kind;

        if (reaped.reason === "dead_pid" && kind === "login" && owner) {
            const reapedMode =
                reaped.payload.mode === "once" || reaped.payload.mode === "stream" ? reaped.payload.mode : undefined;
            await appendFeed(paths, {
                type: "logged_out",
                agent_id: owner,
                reason: "dead_pid",
                mode: reapedMode,
            });
        }
    }

    for (const warning of report.warnings) {
        log.warn({ lock: warning.lock, pid: warning.pid, age_h: warning.age_h }, "lock is long-lived; left in place");
    }
}
