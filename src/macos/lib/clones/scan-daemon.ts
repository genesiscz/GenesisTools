import { logger } from "@app/logger";
import { newProcessId, writeMeta } from "@app/macos/lib/clones/audit";
import { cachePlan } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { formatBytes } from "@app/utils/format";
import { sendNotification } from "@app/utils/macos/notifications";

const log = logger.child({ component: "clones:scan-daemon" });

export interface DaemonScanArgs {
    watchedDirs?: string[];
    notify?: boolean;
}

export interface DaemonScanResult {
    scanned: boolean;
    reclaimable: number;
    dirs: number;
    processId?: string;
}

/** Unattended dry-run scan (NEVER --apply). Writes the 1h plan cache + a
 *  dry-run ProcessReport meta line, emits ONE notification. */
export async function runDaemonScan(args: DaemonScanArgs = {}): Promise<DaemonScanResult> {
    const cfg = await loadClonesConfig();
    const roots = args.watchedDirs ?? cfg.watchedDirs;
    if (!roots || roots.length === 0) {
        log.info("scan-daemon: no watchedDirs configured — nothing to do");
        return { scanned: false, reclaimable: 0, dirs: 0 };
    }

    const minReal = cfg.minReal ?? 10485760;
    const exclude = cfg.exclude ?? [];
    // Surface only the actionable reclaim (what `optimize` would free) — a
    // measure pass would inflate the I/O without changing the notification.
    // The same filters threaded into cachePlan MUST be passed to
    // collapseDuplicates so the cached plan matches its cache key — otherwise
    // a follow-up `optimize` cache hit serves an unfiltered plan against a
    // filter-aware request.
    const sets = collapseDuplicates({ roots, minSize: minReal, exclude }).sets;
    const reclaimable = sets.reduce((s, x) => s + x.reclaimable, 0);

    await cachePlan(
        {
            roots,
            minSize: minReal,
            include: [],
            exclude,
            nodeModules: Boolean(cfg.nodeModules),
        },
        sets
    );

    const id = newProcessId();
    const now = new Date().toISOString();
    writeMeta({ id, state: "dry-run", roots, startedAt: now, endedAt: now, planCacheHit: false });

    if (args.notify !== false) {
        // Notification delivery can fail (missing permissions, Do Not Disturb,
        // notification-center daemon not running). Treat as best-effort — the
        // scan itself succeeded and recorded a dry-run meta line; the user can
        // always see the result via `tools macos clones optimize --list`.
        try {
            await sendNotification({
                title: "macos clones",
                message: `${formatBytes(reclaimable)} reclaimable across ${roots.length} dir(s) — run \`tools macos clones optimize --apply\``,
            });
        } catch (err) {
            log.warn({ err }, "scan-daemon: notification delivery failed (scan results still recorded)");
        }
    }

    log.info({ reclaimable, dirs: roots.length, id }, "scan-daemon dry-run complete");
    return { scanned: true, reclaimable, dirs: roots.length, processId: id };
}

if (import.meta.main) {
    runDaemonScan({ notify: true })
        .then((r) => {
            process.exitCode = r.scanned ? 0 : 0;
        })
        .catch((err) => {
            log.error({ err }, "scan-daemon failed");
            process.exitCode = 1;
        });
}
