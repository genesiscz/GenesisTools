import logger from "@app/logger";
import { newProcessId, writeMeta } from "@app/macos/lib/clones/audit";
import { cachePlan } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { buildMeasureReport } from "@app/macos/lib/clones/orchestrator";
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
    buildMeasureReport({ roots, minReal, breakdown: false });
    const sets = collapseDuplicates({ roots }).sets;
    const reclaimable = sets.reduce((s, x) => s + x.reclaimable, 0);

    await cachePlan(
        {
            roots,
            minSize: minReal,
            include: [],
            exclude: cfg.exclude ?? [],
            nodeModules: Boolean(cfg.nodeModules),
        },
        sets
    );

    const id = newProcessId();
    const now = new Date().toISOString();
    writeMeta({ id, state: "dry-run", roots, startedAt: now, endedAt: now, planCacheHit: false });

    if (args.notify !== false) {
        await sendNotification({
            title: "macos clones",
            message: `${formatBytes(reclaimable)} reclaimable across ${roots.length} dir(s) — run \`tools macos clones optimize --apply\``,
        });
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
