import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { codexHomeOverrides, nativeHome } from "@genesiscz/utils/providers/session-paths";

const { log } = logger.scoped("session-changes");

function listDir(dir: string): string[] {
    try {
        return readdirSync(dir).sort().reverse();
    } catch (error) {
        log.debug({ error, dir }, "codex sessions directory not readable");
        return [];
    }
}

function codexHomes(): string[] {
    const homes = codexHomeOverrides();
    return homes.length > 0 ? homes : [nativeHome("codex")];
}

/**
 * The rollout of a Codex thread: `<home>/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl` (or `.jsonl.zst` once
 * Codex compressed it), or the same in `archived_sessions`, which also keeps files directly in its root. Newest days
 * are searched first.
 */
export function findCodexRollout(threadId: string, homes: string[] = codexHomes()): string | null {
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
        return null;
    }

    const isThread = (entry: string) =>
        entry.startsWith("rollout-") &&
        (entry.endsWith(`-${threadId}.jsonl`) || entry.endsWith(`-${threadId}.jsonl.zst`));

    for (const home of homes) {
        for (const bucket of ["sessions", "archived_sessions"]) {
            const root = join(home, bucket);

            if (!existsSync(root)) {
                continue;
            }

            const flat = listDir(root).find(isThread);

            if (flat) {
                return join(root, flat);
            }

            for (const year of listDir(root)) {
                for (const month of listDir(join(root, year))) {
                    for (const day of listDir(join(root, year, month))) {
                        const dayDir = join(root, year, month, day);
                        const hit = listDir(dayDir).find(isThread);

                        if (hit) {
                            return join(dayDir, hit);
                        }
                    }
                }
            }
        }
    }

    return null;
}

export function isCodexRollout(path: string): boolean {
    return /(^|\/)rollout-[^/]+\.jsonl(?:\.zst)?$/.test(path);
}
