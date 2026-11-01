import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateFile } from "./diff/private-dir";
import { hookDiag } from "./log";
import { claimsRoot, hookDataRoot, mentionsRoot, sweepStampPath, unpushedRoot } from "./paths";

/**
 * When a capture with no `background.json` is abandoned: its post phase never ran (an interrupted turn, a killed
 * hook, a crash). A foreground call ends within its timeout, 10 minutes in Claude Code, so an hour leaves a margin
 * for a slow harness. A background call's capture waits for its task (`flushDeferred`) and keeps the horizon.
 */
export const ABANDONED_CAPTURE_MS = 60 * 60 * 1000;

/** How often a post phase may sweep: one `stat` of the stamp per call in between, no walk. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;

export interface StaleCapture {
    path: string;
    ageMs: number;
    bytes: number;
}

export interface GcResult {
    removed: StaleCapture[];
    kept: number;
    bytes: number;
    write: boolean;
}

function dirBytes(path: string): number {
    let total = 0;

    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);

        // `lstat`: a capture stores a repository's symlinks as links, and its target is not the capture's size.
        try {
            total += entry.isDirectory() ? dirBytes(child) : lstatSync(child).size;
        } catch (err) {
            hookDiag("Could not size a capture entry", { err, child });
        }
    }

    return total;
}

function safeList(path: string): string[] {
    try {
        return readdirSync(path);
    } catch (err) {
        // A session with no capture has no tree, and the session-end hook makes two passes,
        // so this is the normal case twice over rather than a failure worth a line.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            hookDiag("Could not list a capture directory", { err, path });
        }

        return [];
    }
}

/**
 * Removes captures whose command is over. A capture is FINISHED when its post phase ran (it
 * deletes its own directory) and ABANDONED when it did not: a denied command, an interrupted
 * turn, a crash. Both are identified by age, because a Bash call that outlives the horizon
 * has either finished or died.
 *
 * 🛑 The horizon is a floor, never a ceiling: lowering it below the longest command you
 * actually run deletes a LIVE capture and silently loses that command's diff.
 *
 * `abandonedMs` is the shorter age for a capture with no `background.json`, a foreground call
 * (`ABANDONED_CAPTURE_MS`); without it every capture waits for the horizon.
 */
export function collectStaleCaptures(options: {
    now: number;
    horizonMs?: number;
    abandonedMs?: number;
    sessionId?: string;
    root?: string;
    write?: boolean;
}): GcResult {
    const root = options.root ?? hookDataRoot();
    const horizonMs = options.horizonMs ?? 6 * 60 * 60 * 1000;
    const abandonedMs = Math.min(options.abandonedMs ?? horizonMs, horizonMs);
    const write = options.write ?? false;
    const removed: StaleCapture[] = [];
    let kept = 0;
    let bytes = 0;

    for (const harness of safeList(root)) {
        for (const session of safeList(join(root, harness))) {
            if (options.sessionId && session !== options.sessionId) {
                continue;
            }

            const diffDir = join(root, harness, session, "diff");

            for (const call of safeList(diffDir)) {
                const path = join(diffDir, call);
                let ageMs: number;

                try {
                    ageMs = options.now - statSync(path).mtimeMs;
                } catch (err) {
                    hookDiag("Could not stat a capture directory", { err, path });
                    continue;
                }

                // A session sweep is explicit: that session is over, so age does not gate it.
                const limit = existsSync(join(path, "background.json")) ? horizonMs : abandonedMs;

                if (!options.sessionId && ageMs < limit) {
                    kept += 1;
                    continue;
                }

                const size = dirBytes(path);

                removed.push({ path, ageMs, bytes: size });
                bytes += size;

                if (write) {
                    try {
                        rmSync(path, { recursive: true, force: true });
                    } catch (err) {
                        hookDiag("Could not remove a stale capture", { err, path });
                    }
                }
            }

            if (write) {
                // Otherwise the tree keeps one empty `<session>/diff/` per session forever,
                // and "swept" reads as more complete than it is. `rmdir` semantics, never
                // recursive: a capture written between the loop and here must survive.
                removeIfEmpty(diffDir);
                removeIfEmpty(join(root, harness, session));
            }
        }
    }

    // Render claims live beside the captures, one tiny file per file state printed. They are
    // never swept by a session sweep: a claim outlives the session that took it, on purpose,
    // so a later session cannot reprint a change just because the first one ended.
    if (!options.sessionId) {
        for (const claim of safeList(claimsRoot())) {
            const path = join(claimsRoot(), claim);
            let stat: ReturnType<typeof statSync>;

            try {
                stat = statSync(path);
            } catch (err) {
                hookDiag("Could not stat a render claim", { err, path });
                continue;
            }

            const ageMs = options.now - stat.mtimeMs;

            if (ageMs < horizonMs) {
                kept += 1;
                continue;
            }

            removed.push({ path, ageMs, bytes: stat.size });
            bytes += stat.size;

            if (write) {
                try {
                    rmSync(path, { force: true });
                } catch (err) {
                    hookDiag("Could not remove a stale render claim", { err, path });
                }
            }
        }
    }

    // A session's mention index (and its transcript offset) goes with the session, or once
    // nothing has touched it for the horizon. A session that comes back rebuilds it from its
    // transcript, so removing one costs a single backfill read, never a wrong answer.
    for (const name of safeList(mentionsRoot())) {
        const owner = name.replace(/\.(?:txt|json)$/, "");
        const path = join(mentionsRoot(), name);
        let stat: ReturnType<typeof statSync>;

        try {
            stat = statSync(path);
        } catch (err) {
            hookDiag("Could not stat a mention index", { err, path });
            continue;
        }

        const ageMs = options.now - stat.mtimeMs;

        if (options.sessionId ? owner !== options.sessionId : ageMs < horizonMs) {
            continue;
        }

        removed.push({ path, ageMs, bytes: stat.size });
        bytes += stat.size;

        if (write) {
            try {
                rmSync(path, { force: true });
            } catch (err) {
                hookDiag("Could not remove a mention index", { err, path });
            }
        }
    }

    // The unpushed reminder's cache and claims: one small file per repository per interval.
    if (!options.sessionId) {
        for (const name of safeList(unpushedRoot())) {
            const path = join(unpushedRoot(), name);
            let stat: ReturnType<typeof statSync>;

            try {
                stat = statSync(path);
            } catch (err) {
                hookDiag("Could not stat an unpushed reminder file", { err, path });
                continue;
            }

            const ageMs = options.now - stat.mtimeMs;

            if (ageMs < horizonMs) {
                continue;
            }

            removed.push({ path, ageMs, bytes: stat.size });
            bytes += stat.size;

            if (write) {
                try {
                    rmSync(path, { force: true });
                } catch (err) {
                    hookDiag("Could not remove an unpushed reminder file", { err, path });
                }
            }
        }
    }

    return { removed, kept, bytes, write };
}

/**
 * The sweep a post phase runs: captures whose post phase never ran, an hour on (`ABANDONED_CAPTURE_MS`), and
 * everything else past the horizon, at most once per `everyMs`. Before it only a session end swept, and only past
 * six hours, so a session that ran for days kept every interrupted call's capture. The stamp's mtime is the last
 * sweep; it lives beside the data root, which `collectStaleCaptures` walks as harnesses. `null`: not due yet.
 */
export function sweepAbandonedCaptures({
    now,
    root,
    stamp = sweepStampPath(),
    everyMs = SWEEP_EVERY_MS,
}: {
    now: number;
    root?: string;
    stamp?: string;
    everyMs?: number;
}): GcResult | null {
    try {
        if (now - statSync(stamp).mtimeMs < everyMs) {
            return null;
        }
    } catch (err) {
        // No stamp yet is the first sweep on this machine.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            hookDiag("Could not read the capture sweep stamp", { err, stamp });
            return null;
        }
    }

    // Stamped BEFORE the walk, so the post phases of a parallel batch do not all sweep at once.
    try {
        assertPrivateFile(stamp);
        writeFileSync(stamp, "", { mode: 0o600 });
        utimesSync(stamp, new Date(now), new Date(now));
    } catch (err) {
        hookDiag("Could not write the capture sweep stamp", { err, stamp });
        return null;
    }

    return collectStaleCaptures({ now, abandonedMs: ABANDONED_CAPTURE_MS, root, write: true });
}

function removeIfEmpty(dir: string): void {
    try {
        if (readdirSync(dir).length === 0) {
            rmdirSync(dir);
        }
    } catch (err) {
        hookDiag("Could not remove an empty capture directory", { err, dir });
    }
}

/** `6h`, `30m`, `0s`, `2d`, or a bare number of seconds. */
export function parseHorizon(value: string): number {
    const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());

    if (!match?.[1]) {
        throw new Error(`--older-than takes a duration like 6h, 30m or 0s, not ${value}`);
    }

    const amount = Number(match[1]);
    const unit = match[2] ?? "s";
    const scale = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000;

    return amount * scale;
}
