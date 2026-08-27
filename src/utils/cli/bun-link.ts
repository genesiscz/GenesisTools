import { existsSync, linkSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/**
 * Resolve a bun executable named after the tool it will run, so the process
 * shows up in Activity Monitor / ps / pgrep as "gt-<name>" instead of "bun".
 *
 * Activity Monitor names a process after its resolved executable file and
 * follows symlinks (verified 2026-08-26), so only a HARDLINK changes the
 * displayed name. A hardlink shares the binary's inode: zero disk cost and
 * the code signature stays intact. `bun upgrade` writes a new inode, so a
 * link whose inode no longer matches the live binary is re-created. Any
 * filesystem failure (cross-device tmp, concurrent create race) falls back
 * to the plain bun binary, which merely keeps the old "bun" display name.
 */
export function namedBunExecPath(name: string, bunPath: string = process.execPath): string {
    if (process.platform === "win32") {
        return bunPath;
    }

    const linkName = `gt-${name.replace(/[^\w.-]+/g, "-")}`;
    const binDir = join(env.tools.getHome(), ".genesis-tools", "bin");
    const linkPath = join(binDir, linkName);

    try {
        const bunStat = statSync(bunPath);

        if (existsSync(linkPath)) {
            const linkStat = statSync(linkPath);
            if (linkStat.ino === bunStat.ino && linkStat.dev === bunStat.dev) {
                return linkPath;
            }

            unlinkSync(linkPath);
        }

        mkdirSync(binDir, { recursive: true });
        linkSync(bunPath, linkPath);
        return linkPath;
    } catch (err) {
        logger.debug({ err, linkPath }, "[bun-link] hardlink failed, falling back to the bun binary");
        return bunPath;
    }
}
