import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { liveBlobDir, liveIdbDir, snapshotDir } from "./paths";

const log = logger.scoped("ms-teams").log;

export interface SnapshotPaths {
    leveldbDir: string;
    blobDir: string;
    dumpDir: string;
}

export function snapshotTeamsIdb(): SnapshotPaths {
    const idb = liveIdbDir();
    const blob = liveBlobDir();

    if (!existsSync(idb)) {
        throw new Error(
            `Teams IndexedDB not found at ${idb}. Grant Full Disk Access to your terminal, then run tools ms-teams doctor.`
        );
    }

    const root = snapshotDir();
    const leveldbDir = join(root, "idb");
    const blobDir = join(root, "blob");
    const dumpDir = join(root, "dump");

    rmSync(leveldbDir, { recursive: true, force: true });
    rmSync(blobDir, { recursive: true, force: true });
    mkdirSync(leveldbDir, { recursive: true });
    mkdirSync(dumpDir, { recursive: true });
    cpSync(idb, leveldbDir, { recursive: true });

    if (existsSync(blob)) {
        cpSync(blob, blobDir, { recursive: true });
    } else {
        mkdirSync(blobDir, { recursive: true });
    }

    const size = statSync(idb).isDirectory() ? 0 : statSync(idb).size;
    log.debug({ idb, leveldbDir, size }, "[ms-teams] snapshotted IndexedDB");

    return { leveldbDir, blobDir, dumpDir };
}
