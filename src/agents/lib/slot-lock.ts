import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sweepStaleLocks } from "@genesiscz/utils/storage/stale-lock-sweep";
import { deriveRegistry } from "./derived-registry";
import { appendFeed, readFeed } from "./feed";
import { announceLapses, announceLeave, rearmUntil } from "./leave";
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

/**
 * Remove the slot when it still names this process. A login whose dead-looking slot was reaped and then claimed by a
 * new login must not delete the new holder's claim on its way out.
 */
export function releaseSlot(lockPath: string): void {
    try {
        const holder = readSlotPayload(lockPath);

        if (holder?.pid !== process.pid) {
            log.debug({ lockPath, holder: holder?.pid }, "slot names another process; leaving it");
            return;
        }

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

/** Reap dead logins' slots through the shared fenced takeover (`sweepStaleLocks`), then report each one on the feed. */
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

        // A recycled pid means the login holder is just as gone as a dead one.
        if ((reaped.reason === "dead_pid" || reaped.reason === "recycled_pid") && kind === "login" && owner) {
            const reapedMode =
                reaped.payload.mode === "once" || reaped.payload.mode === "stream" ? reaped.payload.mode : undefined;
            const loginId = typeof reaped.payload.login_id === "string" ? reaped.payload.login_id : undefined;
            // A dead login (a harness killed it hard) is a re-arm like a signal: the agent stays on the bus for the
            // grace, and announceLapses below or a watching login reports it if no new login follows. A lock from
            // before login ids has nothing to match a new login against, so it is announced at once.
            await appendFeed(paths, {
                type: "logged_out",
                agent_id: owner,
                reason: "dead_pid",
                mode: reapedMode,
                ...(loginId ? { login_id: loginId, rearm_until: rearmUntil() } : {}),
            });

            if (!loginId) {
                const record = deriveRegistry(await readFeed(paths)).find((entry) => entry.agent_id === owner);
                await announceLeave(paths, {
                    agent_id: owner,
                    agent_name: record?.agent_name ?? owner,
                    reason: "dead_pid",
                });
            }
        }
    }

    // Every login, message and listen passes here, so a lapse is written even when no login is watching.
    await announceLapses(paths);

    for (const warning of report.warnings) {
        log.warn({ lock: warning.lock, pid: warning.pid, age_h: warning.age_h }, "lock is long-lived; left in place");
    }
}
