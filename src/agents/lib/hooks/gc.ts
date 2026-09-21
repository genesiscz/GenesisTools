import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hookDiag } from "./log";
import { claimsRoot, hookDataRoot } from "./paths";

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

        try {
            total += entry.isDirectory() ? dirBytes(child) : statSync(child).size;
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
 */
export function collectStaleCaptures(options: {
    now: number;
    horizonMs?: number;
    sessionId?: string;
    root?: string;
    write?: boolean;
}): GcResult {
    const root = options.root ?? hookDataRoot();
    const horizonMs = options.horizonMs ?? 6 * 60 * 60 * 1000;
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
                if (!options.sessionId && ageMs < horizonMs) {
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

    // Render claims live beside the captures, one tiny file per path ever printed. They are
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

    return { removed, kept, bytes, write };
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
