import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import type { DiskUsageEntry, DiskUsageResult } from "./types";

/** One `du -sk` row is "<kilobytes>\t<path>"; split on the FIRST whitespace run so paths with
 *  spaces survive. KB × 1024 → bytes. Bad/blank rows are skipped. Output is sorted bytes-desc. */
export function parseDuOutput(out: string): Array<{ path: string; bytes: number }> {
    const rows: Array<{ path: string; bytes: number }> = [];

    for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const match = trimmed.match(/^(\d+)\s+(.+)$/);
        if (!match) {
            continue;
        }

        const kb = Number.parseInt(match[1], 10);
        if (Number.isNaN(kb)) {
            continue;
        }

        rows.push({ path: match[2], bytes: kb * 1024 });
    }

    rows.sort((a, b) => b.bytes - a.bytes);
    return rows;
}

/** A short display label: collapse a home prefix to `~`, else keep the last two path segments. */
export function shortLabel(path: string, home = homedir()): string {
    if (home && path.startsWith(`${home}/`)) {
        return `~/${path.slice(home.length + 1)}`;
    }

    const segments = path.split("/").filter(Boolean);
    return segments.slice(-2).join("/") || path;
}

/**
 * SAFE ALLOWLIST of common dev space-eaters. Read-only — v1 has no delete. Resolved against the
 * dashboard host's $HOME and the current working dir (the project the agent was started in), then
 * filtered to paths that actually exist so a missing dir never errors the route.
 */
export function diskUsageTargets(home = homedir(), cwd = process.cwd()): string[] {
    const candidates = [
        join(cwd, "node_modules"),
        join(cwd, "dist"),
        join(cwd, "build"),
        join(cwd, "ios", "build"),
        join(cwd, ".next"),
        join(cwd, ".expo"),
        join(home, "Library", "Caches"),
        join(home, ".cache"),
        join(home, ".npm"),
        join(home, ".bun", "install", "cache"),
        join(home, "Library", "Developer", "Xcode", "DerivedData"),
    ];

    return candidates.filter((p) => existsSync(p));
}

/**
 * Per-`du` wall-clock budget (ms). `du -sk` must `stat` every file in the subtree to total it, so a
 * huge cache dir (Xcode DerivedData, ~/Library/Caches) can run 30 s+ and peg disk/CPU — long enough
 * to hang the /api/disk/usage route and re-spike the host. We bound each call: if `du` overruns the
 * budget we kill it and skip that path (returns null), so the route always answers in ~a few seconds
 * regardless of dir size. Override via DD_DISK_DU_TIMEOUT_MS (e.g. tighten in tests/CI).
 */
export const DEFAULT_DU_TIMEOUT_MS = 4000;

export function duTimeoutMs(): number {
    const raw = process.env.DD_DISK_DU_TIMEOUT_MS;
    if (!raw) {
        return DEFAULT_DU_TIMEOUT_MS;
    }

    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DU_TIMEOUT_MS;
}

/**
 * Run `du -sk <path>` for one allowlist path, bounded by `timeoutMs`. Returns bytes, null on failure,
 * or null when the scan overruns the budget (the process is killed so it can't keep pegging the host).
 * Never throws.
 */
async function duPath(path: string, timeoutMs = duTimeoutMs()): Promise<number | null> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const child = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
        timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);

        const out = await new Response(child.stdout).text();
        await child.exited;

        if (timedOut) {
            logger.debug({ path, timeoutMs }, "du -sk exceeded budget; killed + skipped");
            return null;
        }

        if (child.exitCode !== 0) {
            return null;
        }

        const parsed = parseDuOutput(out);
        return parsed[0]?.bytes ?? null;
    } catch (err) {
        logger.debug({ err, path }, "du -sk failed for path; skipping");
        return null;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/** Measure every existing allowlist path, build sorted entries. `available:false` when none resolved. */
export async function collectDiskUsage(): Promise<DiskUsageResult> {
    const scannedAt = new Date().toISOString();
    const targets = diskUsageTargets();

    if (targets.length === 0) {
        logger.debug("disk usage: no allowlist paths exist on this host");
        return { available: false, scannedAt, entries: [] };
    }

    const measured = await Promise.all(
        targets.map(async (path): Promise<DiskUsageEntry | null> => {
            const bytes = await duPath(path);
            if (bytes === null) {
                return null;
            }

            return { path, label: shortLabel(path), bytes };
        })
    );

    const entries = measured
        .filter((e): e is DiskUsageEntry => e !== null)
        .sort((a, b) => b.bytes - a.bytes);

    return { available: entries.length > 0, scannedAt, entries };
}
