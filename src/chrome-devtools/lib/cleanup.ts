/**
 * `cleanup` — the mutating counterpart of doctor. Every destructive action is
 * verified at apply time: kills re-check the pid still runs a recorder-shaped
 * command (pid recycling), pidfiles are cleared through the pidfile module,
 * and captures are MOVED to a trash dir under /tmp, never destroyed in place.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { attemptStaleTakeover, inspectPidFile, readLivePid } from "@genesiscz/utils/process/pidfile";
import { captureDir, knownCapturePorts, listLegacyArmFiles, recorderPidPath } from "./paths.ts";
import { defaultExec, type ExecFn, terminatePid, tmpRoot } from "./platform.ts";
import { ancestorPids, findRecorderProcesses } from "./status.ts";

const { log } = logger.scoped("chrome-devtools:cleanup");

export interface CleanupResult {
    ok: boolean;
    message: string;
}

function trashDir(): string {
    const dir = join(tmpRoot(), "GenesisTools", "ChromeDevtools", `trash-${new Date().toISOString().slice(0, 10)}`);
    mkdirSync(dir, { recursive: true });

    return dir;
}

/** Live pidfile-owned recorder pids, keyed by port. Injectable for tests. */
export function liveRecorderPids(): Map<number, number> {
    const owned = new Map<number, number>();
    for (const port of knownCapturePorts()) {
        const pid = readLivePid(recorderPidPath(port));
        if (pid !== null) {
            owned.set(port, pid);
        }
    }

    return owned;
}

/**
 * SIGTERM a recorder-shaped pid. Refuses when the pid no longer looks like a
 * recorder (recycled), IS a live pidfile-owned recorder (stop it with
 * `record --stop` instead), or is an ANCESTOR of one (the launch chain carries
 * the same argv — killing it tears down a healthy recorder).
 */
export function killRecorderPid(
    pid: number,
    exec: ExecFn = defaultExec,
    owned: () => Map<number, number> = liveRecorderPids
): CleanupResult {
    const current = findRecorderProcesses(exec).find((p) => p.pid === pid);
    if (!current) {
        return {
            ok: false,
            message: `pid ${pid} is not a recorder-shaped process (gone, or the pid was recycled). Refusing to kill it.`,
        };
    }

    const live = owned();
    for (const [port, livePid] of live) {
        if (livePid === pid) {
            return {
                ok: false,
                message: `pid ${pid} IS the live recorder for port ${port}. Stop it properly: record --port ${port} --stop`,
            };
        }
    }

    if (ancestorPids(live.values(), exec).has(pid)) {
        return {
            ok: false,
            message: `pid ${pid} is a launcher ancestor of a LIVE recorder. Killing it would tear the recorder down; refusing.`,
        };
    }

    const r = terminatePid(pid, exec);
    if (r.exitCode !== 0) {
        return { ok: false, message: `kill ${pid} failed: ${r.stderr.trim()}` };
    }

    log.info({ pid, command: current.command }, "recorder killed");

    return { ok: true, message: `stopped pid ${pid} (${current.command.slice(0, 80)})` };
}

/**
 * Clear a dead/foreign pidfile for a port. Refuses a LIVE or UNVERIFIED one
 * (`unverified` = the pid is alive but the OS would not name it — the normal
 * Windows answer; an alive recorder's claim must never be deleted). The
 * delete itself is the shared rename-verify takeover with `claim: false`, so
 * a recorder claiming the path mid-clear keeps its file — a compare followed
 * by a separate unlink would race. `hooks.afterInspect` exists ONLY so tests
 * can interleave a rival claim deterministically.
 */
export async function clearStalePidfile(port: number, hooks?: { afterInspect?: () => void }): Promise<CleanupResult> {
    const path = recorderPidPath(port);
    if (!existsSync(path)) {
        return { ok: true, message: `port ${port}: no pidfile` };
    }

    let staleContent: string;
    try {
        staleContent = readFileSync(path, "utf8");
    } catch (err) {
        // ENOENT here is a benign vanish; anything else (permissions, I/O)
        // must be visible or the cleanup failure is undiagnosable.
        log.debug({ err, path }, "pidfile read failed during stale clear");

        return { ok: true, message: `port ${port}: pidfile vanished while inspecting (nothing to clear)` };
    }

    const state = inspectPidFile(path);
    if (state.status === "live" || state.status === "unverified") {
        return {
            ok: false,
            message: `port ${port}: that pidfile belongs to a LIVE recorder (pid ${state.pid}). Stop it properly: record --port ${port} --stop`,
        };
    }

    hooks?.afterInspect?.();

    const cleared = await attemptStaleTakeover(path, staleContent, { claim: false });

    return cleared
        ? { ok: true, message: `port ${port}: stale pidfile cleared` }
        : {
              ok: false,
              message: `port ${port}: pidfile changed while clearing — a recorder just claimed it, leaving it alone`,
          };
}

/** Move legacy /tmp/cdp-arm-* files to the trash dir (recoverable until reboot). Optional per-port scope. */
export function moveLegacyFiles(ports?: number[]): CleanupResult {
    const all = listLegacyArmFiles();
    const files = ports?.length ? all.filter((f) => ports.some((p) => f.includes(`cdp-arm-${p}.`))) : all;
    if (files.length === 0) {
        return {
            ok: true,
            message: `no legacy /tmp/cdp-arm-* files${ports?.length ? ` for port(s) ${ports.join(", ")}` : ""}`,
        };
    }

    const dir = trashDir();
    const moved: string[] = [];
    for (const file of files) {
        try {
            // Timestamp prefix: a same-day recreation of the same filename must
            // not overwrite the earlier trashed copy (recoverable contract).
            renameSync(file, join(dir, `${Date.now()}-${basename(file)}`));
            moved.push(file);
        } catch (err) {
            log.warn({ err, file }, "legacy file move failed");
        }
    }

    return {
        ok: moved.length === files.length,
        message: `moved ${moved.length}/${files.length} legacy file(s) to ${dir} (moved, not destroyed; /tmp clears on reboot)`,
    };
}

export interface PlannedAction {
    label: string;
    /** Kills never ride `--yes` or a batch shortcut; they need an explicit --kill or an interactive pick. */
    kind: "kill" | "safe";
    apply: () => CleanupResult | Promise<CleanupResult>;
}

/** Findings → concrete cleanup actions. Pure mapping; the safety property is the `kind` tag. */
export function actionsFromFindings(findings: { id: string }[]): PlannedAction[] {
    const actions: PlannedAction[] = [];

    for (const f of findings) {
        const orphan = f.id.match(/^orphan-(\d+)$/);
        if (orphan) {
            const pid = Number(orphan[1]);
            actions.push({ label: `kill orphan recorder pid ${pid}`, kind: "kill", apply: () => killRecorderPid(pid) });
        }

        const stale = f.id.match(/^(stale-pidfile|recycled-pid)-(\d+)$/);
        if (stale) {
            const port = Number(stale[2]);
            actions.push({
                label: `clear stale pidfile for port ${port}`,
                kind: "safe",
                apply: () => clearStalePidfile(port),
            });
        }

        if (f.id === "legacy-arm-files") {
            actions.push({
                label: "move legacy /tmp/cdp-arm-* files to trash",
                kind: "safe",
                apply: () => moveLegacyFiles(),
            });
        }

        const leftover = f.id.match(/^leftover-buffer-(\d+)$/);
        if (leftover) {
            const port = Number(leftover[1]);
            actions.push({
                label: `move leftover capture buffer of port ${port} to trash (dump it FIRST if you still need a HAR)`,
                kind: "safe",
                apply: () => moveCaptureDir(port),
            });
        }
    }

    return actions;
}

/** What `--yes` may run: the safe subset, never kills. The excluded kills are returned for the warning lines. */
export function partitionForYes(actions: PlannedAction[]): {
    batchable: PlannedAction[];
    excludedKills: PlannedAction[];
} {
    return {
        batchable: actions.filter((a) => a.kind === "safe"),
        excludedKills: actions.filter((a) => a.kind === "kill"),
    };
}

/** Move a port's capture dir to trash (recoverable until reboot). */
export function moveCaptureDir(port: number): CleanupResult {
    const dir = captureDir(port);
    if (!existsSync(dir)) {
        return { ok: true, message: `port ${port}: no capture dir` };
    }

    const dest = join(trashDir(), `port-${port}-${Date.now()}`);
    try {
        renameSync(dir, dest);
    } catch (err) {
        return { ok: false, message: `port ${port}: move failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    return {
        ok: true,
        message: `port ${port}: capture moved to ${dest} (moved, not destroyed; /tmp clears on reboot)`,
    };
}
