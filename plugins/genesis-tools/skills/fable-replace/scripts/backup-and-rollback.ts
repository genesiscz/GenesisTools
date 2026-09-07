/**
 * fable-replace — BACKUP AND ROLLBACK. The undo story.
 *
 * `backupDir` snapshots every file the sweep is about to touch, plus a manifest,
 * BEFORE anything is written. After the write phase the manifest also records a
 * hash of what the sweep produced.
 *
 * `rollback(dir)` restores byte-for-byte — but SKIPS any file whose content changed
 * after the sweep wrote it (a hand edit, a formatter, a later sweep) and reports it
 * as drifted, because restoring it would destroy work the snapshot never saw. Pass
 * `force: true` to restore those too. A side effect worth knowing: stacked
 * sweeps therefore refuse to unwind out of order.
 *
 * Never point two sweeps at one backupDir — the second overwrites the first
 * snapshot. The runner refuses this in pre-flight.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FableReplaceError } from "./internal";
import { parseJson, stringifyJson } from "./json";
import type { PruneParams, PruneReport, RollbackParams, RollbackReport, WriteBackupParams } from "./types";

interface BackupManifestEntry {
    /** Absolute original path. */
    original: string;
    /** File name inside the backup dir, or null when the file did not exist (created/renamed targets). */
    stored: string | null;
    /**
     * sha256 of what the sweep WROTE to `original`, filled in after the write phase
     * (null when the sweep deleted the file). `rollback()` compares against it, so an
     * edit made by hand after the sweep is never silently overwritten.
     */
    hashAfter?: string | null;
}

const MANIFEST_NAME = "fable-replace-manifest.json";

const hashOf = (file: string): string | null => {
    if (!fs.existsSync(file)) {
        return null;
    }
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
};

/** Is `dir` already holding a manifest from an earlier sweep? */
export const backupDirInUse = (dir: string): string | null => {
    const manifestPath = path.join(dir, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    try {
        return (
            (parseJson(fs.readFileSync(manifestPath, "utf8")) as { createdAt?: string }).createdAt ?? "an earlier run"
        );
    } catch {
        return "an unreadable earlier manifest";
    }
};

export const writeBackup = ({ dir, files, overwrite = false }: WriteBackupParams): void => {
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, MANIFEST_NAME);
    const createdAt = new Date().toISOString();
    // Reserve the dir BEFORE any byte is copied. The stored names are deterministic
    // (0000-<name>), so a second writer that copied first would overwrite the first
    // snapshot's originals and only then fail on the manifest. "wx" fails when the manifest
    // already exists, and the pre-flight `backupDirInUse` check cannot cover two sweeps
    // racing past it. The loser fails loudly here, with the winner's snapshot intact.
    try {
        fs.writeFileSync(manifestPath, stringifyJson({ createdAt, entries: [] }, 2), { flag: overwrite ? "w" : "wx" });
    } catch (err) {
        throw new FableReplaceError(
            `backup dir ${dir} gained a manifest while this sweep was starting: another sweep is using it. Give this run its own backupDir (scratchDir("my-sweep")). Nothing was written. (${String(err)})`,
            2
        );
    }

    const entries: BackupManifestEntry[] = [];
    let i = 0;
    for (const file of files) {
        if (fs.existsSync(file)) {
            const stored = `${String(i).padStart(4, "0")}-${path.basename(file)}`;
            fs.copyFileSync(file, path.join(dir, stored));
            entries.push({ original: file, stored });
        } else {
            entries.push({ original: file, stored: null });
        }
        i += 1;
    }
    fs.writeFileSync(manifestPath, stringifyJson({ createdAt, entries }, 2));
};

/**
 * Record what the sweep actually wrote, so `rollback()` can detect a file that
 * changed again afterwards. Called once, after the write phase succeeds.
 */
export const recordPostWriteHashes = (dir: string): void => {
    const manifestPath = path.join(dir, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
        return;
    }
    const manifest = parseJson(fs.readFileSync(manifestPath, "utf8")) as {
        createdAt: string;
        entries: BackupManifestEntry[];
    };
    for (const entry of manifest.entries) {
        try {
            entry.hashAfter = hashOf(entry.original);
        } catch (err) {
            // A verify command may have turned the path into a directory or made it
            // unreadable. Without a hash the rollback restores it with no drift check, the
            // right default for a path this run can no longer describe.
            entry.hashAfter = undefined;
            console.error(
                `⚠ could not hash ${entry.original} after the write (${String(err)}); its rollback skips the drift check`
            );
        }
    }
    fs.writeFileSync(manifestPath, stringifyJson(manifest, 2));
};

/**
 * Restore every file recorded in a backup dir's manifest byte-for-byte.
 * Files that did not exist at backup time are deleted if they exist now.
 *
 * A file that changed AFTER the sweep wrote it (someone edited it by hand, a
 * formatter ran, a later sweep touched it) is reported as drifted and SKIPPED —
 * restoring it would destroy work the backup never saw. Pass `force: true`
 * to restore those too.
 */
export const rollback = ({ backupDir, force = false, only }: RollbackParams): RollbackReport => {
    const manifestPath = path.join(backupDir, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`No ${MANIFEST_NAME} in ${backupDir} — not a fable-replace backup dir`);
    }
    const manifest = parseJson(fs.readFileSync(manifestPath, "utf8")) as { entries: BackupManifestEntry[] };
    const report: RollbackReport = { restored: [], drifted: [], failed: [] };
    const wanted = only === undefined ? null : new Set(only.map((file) => path.resolve(file)));
    for (const entry of manifest.entries) {
        if (wanted !== null && !wanted.has(path.resolve(entry.original))) {
            continue;
        }

        // Every entry is inspected AND restored inside its OWN guard. The obstruction that
        // broke the sweep (a read-only file, a full disk) usually blocks the restore of the
        // SAME file, and an uncaught throw here used to abandon every LATER entry with the
        // rejected sweep content still live, under an exit code that read as a routine
        // failure. The drift check reads the file too: a path that became unreadable, or a
        // directory, threw before the guard and stranded the rest the same way.
        try {
            if (
                entry.hashAfter !== undefined &&
                force &&
                fs.existsSync(entry.original) &&
                hashOf(entry.original) !== entry.hashAfter
            ) {
                // `force` still overwrites, but never silently. The content here is neither what
                // the sweep wrote nor the snapshot, so this file is not simply "drifted": a
                // hand-edited manifest pointing somewhere else looks exactly the same, and the
                // tool's own drift message invites the user to run `--force` next.
                console.error(`⚠ FORCING over content this sweep never wrote: ${entry.original}`);
            }

            if (entry.hashAfter !== undefined && !force) {
                const now = hashOf(entry.original);
                if (now !== entry.hashAfter) {
                    // Already back at the snapshot (a previous rollback, or a hand revert) is
                    // not drift: nothing would be lost by restoring, and nothing needs doing.
                    const original = entry.stored === null ? null : hashOf(path.join(backupDir, entry.stored));
                    if (now === original) {
                        console.log(`· already at its original content: ${entry.original}`);
                        report.restored.push(entry.original);
                        continue;
                    }
                    report.drifted.push(entry.original);
                    console.log(`⚠ SKIPPED, changed since the sweep: ${entry.original}`);
                    continue;
                }
            }

            if (entry.stored === null) {
                if (fs.existsSync(entry.original)) {
                    fs.rmSync(entry.original);
                    console.log(`↩ deleted (did not exist at backup time): ${entry.original}`);
                }
            } else {
                const stored = path.join(backupDir, entry.stored);
                if (fs.existsSync(entry.original) && hashOf(entry.original) === hashOf(stored)) {
                    // Byte-identical already: copying would only bump the mtime and wake
                    // every file watcher and incremental build cache for nothing.
                    console.log(`· already at its original content: ${entry.original}`);
                    report.restored.push(entry.original);
                    continue;
                }

                fs.mkdirSync(path.dirname(entry.original), { recursive: true });
                fs.copyFileSync(stored, entry.original);
                console.log(`↩ restored: ${entry.original}`);
            }
        } catch (err) {
            report.failed.push({ file: entry.original, error: String(err) });
            console.error(`✗ COULD NOT RESTORE, still holds the swept content: ${entry.original} — ${String(err)}`);
            continue;
        }

        report.restored.push(entry.original);
    }
    console.log(
        `Rollback complete: ${report.restored.length} restored, ${report.drifted.length} skipped as changed, ${report.failed.length} FAILED, from ${backupDir}`
    );
    if (report.drifted.length > 0) {
        console.log(
            `  re-run with rollback({ backupDir, force: true }) to overwrite the ${report.drifted.length} changed file(s) too.`
        );
    }
    if (report.failed.length > 0) {
        console.error(`🛑 ${report.failed.length} file(s) still hold the swept content and could NOT be restored:`);
        for (const f of report.failed) {
            console.error(`   ${f.file}`);
        }
        console.error(
            `   Fix the cause (permissions, disk space), then re-run the rollback: the backup at ${backupDir} is intact.`
        );
    }
    return report;
};

/** One root for every scratch and backup dir, so a listing and a prune stay cheap and scoped. */
export const scratchRoot = (): string => path.join(os.tmpdir(), "fable-replace");

/**
 * A collision-proof scratch directory under `<tmp>/fable-replace/`.
 *
 * /tmp is shared machine-wide. Two agents running similar sweeps in parallel both
 * reached for `/tmp/sweep-dry.log` and one silently overwrote the other's evidence,
 * so a log read back from disk described a different sweep entirely. Never hard-code
 * a generic /tmp path for a backupDir or a log.
 */
export const scratchDir = (label: string): string => {
    const root = scratchRoot();
    fs.mkdirSync(root, { recursive: true });
    // mkdtemp, not a timestamp: two calls in the same millisecond must not collide.
    return fs.mkdtempSync(path.join(root, `${label}-${process.pid}-`));
};

/** Longer than any session's need for its undo trail, shorter than a typical uptime, so it fires. */
export const PRUNE_TTL_MS = 12 * 60 * 60 * 1000;
const PRUNE_MAX_REMOVALS = 50;
/** The layout before the single root: dirs directly under the temp dir, swept by the same gate. */
const LEGACY_PREFIX = "fable-replace-";

/**
 * Only a dir this tool created AND finished writing (it holds the manifest), or an empty
 * one. A name pattern could match someone else's dir; a manifest cannot. That is also
 * what protects scratch dirs without one, such as a selftest's own.
 */
const isPrunable = (dir: string): boolean => {
    try {
        const entries = fs.readdirSync(dir);
        return entries.length === 0 || entries.includes(MANIFEST_NAME);
    } catch {
        // Vanished between the listing and this read: another prune got it first.
        return false;
    }
};

const dirBytes = (dir: string): number => {
    let bytes = 0;
    try {
        for (const name of fs.readdirSync(dir)) {
            try {
                const stat = fs.statSync(path.join(dir, name));
                if (stat.isFile()) {
                    bytes += stat.size;
                }
            } catch {
                // A file removed under us costs nothing to skip.
            }
        }
    } catch {
        // The dir itself vanished: nothing to count.
    }
    return bytes;
};

const listDirs = (dir: string, filter: (name: string) => boolean): string[] => {
    try {
        return fs
            .readdirSync(dir)
            .filter(filter)
            .map((name) => path.join(dir, name));
    } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
            return [];
        }

        throw err;
    }
};

/**
 * Remove stale scratch dirs. Age-only (never count- or size-based, so a live run's young
 * dir is safe and two prunes at once are benign), manifest-gated, capped per run, and the
 * dirs in `keep` are never touched. Only the temp dir this process writes to is swept
 * (`os.tmpdir()`, so TMPDIR decides), never another root. Legacy `fable-replace-*`
 * entries directly under it fall under the same gate.
 *
 * On a machine that reboots often this rarely fires: a reboot empties the temp folder
 * first. It pays off on machines that stay up for weeks.
 */
export const pruneScratch = ({
    ttlMs = PRUNE_TTL_MS,
    maxRemovals = PRUNE_MAX_REMOVALS,
    keep = [],
    now = Date.now(),
}: PruneParams = {}): PruneReport => {
    // One root only: the temp dir THIS process writes to. A launchd job with no TMPDIR has
    // os.tmpdir() === /tmp and prunes /tmp itself. Sweeping /tmp from every process as well
    // made a TMPDIR-redirected run (the selftest, a sandbox) delete backups it never wrote.
    const temp = os.tmpdir();
    const candidates = [
        ...listDirs(path.join(temp, "fable-replace"), () => true),
        ...listDirs(temp, (name) => name.startsWith(LEGACY_PREFIX)),
    ];

    const keepSet = new Set(keep.map((dir) => path.resolve(dir)));
    const report: PruneReport = {
        scanned: candidates.length,
        removed: 0,
        bytes: 0,
        roots: [path.join(temp, "fable-replace")],
    };
    for (const dir of candidates) {
        if (report.removed >= maxRemovals) {
            break;
        }

        if (keepSet.has(path.resolve(dir))) {
            continue;
        }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(dir);
        } catch {
            // Gone already: a concurrent prune or the OS sweep.
            continue;
        }

        if (!stat.isDirectory() || now - stat.mtimeMs < ttlMs || !isPrunable(dir)) {
            continue;
        }

        const bytes = dirBytes(dir);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // Refused by the filesystem: leave it, the next run tries again.
            continue;
        }

        report.removed += 1;
        report.bytes += bytes;
    }

    return report;
};
