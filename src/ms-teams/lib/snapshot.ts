import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
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
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);

    const leveldbDir = join(root, "idb");
    const blobDir = join(root, "blob");
    const dumpDir = join(root, "dump");
    const tmpIdb = join(root, `idb.tmp.${process.pid}`);
    const tmpBlob = join(root, `blob.tmp.${process.pid}`);

    rmSync(tmpIdb, { recursive: true, force: true });
    rmSync(tmpBlob, { recursive: true, force: true });
    mkdirSync(tmpIdb, { recursive: true, mode: 0o700 });
    cpSync(idb, tmpIdb, { recursive: true });
    rmSync(leveldbDir, { recursive: true, force: true });
    renameSync(tmpIdb, leveldbDir);
    chmodSync(leveldbDir, 0o700);

    if (existsSync(blob)) {
        mkdirSync(tmpBlob, { recursive: true, mode: 0o700 });
        cpSync(blob, tmpBlob, { recursive: true });
        rmSync(blobDir, { recursive: true, force: true });
        renameSync(tmpBlob, blobDir);
        chmodSync(blobDir, 0o700);
    } else {
        mkdirSync(blobDir, { recursive: true, mode: 0o700 });
    }

    mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
    chmodSync(dumpDir, 0o700);

    log.debug({ idb, leveldbDir }, "[ms-teams] snapshotted IndexedDB");

    return { leveldbDir, blobDir, dumpDir };
}

// LevelDB appends new records to its .log file and rewrites CURRENT only when it rolls the manifest,
// so the newest mtime of any file in the directory is the only reliable "something changed" signal.
export function liveIdbMtimeMs(dir: string = liveIdbDir()): number {
    if (!existsSync(dir)) {
        return 0;
    }

    let newest = statSync(dir).mtimeMs;

    for (const name of readdirSync(dir)) {
        try {
            newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
        } catch {
            // LevelDB deletes compacted files while we list them.
        }
    }

    return newest;
}
