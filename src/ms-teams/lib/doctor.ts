import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { cacheDbPath, liveBlobDir, liveIdbDir, venvPython } from "./paths";
import { teamsAppIsUp } from "./process";
import { TeamsCache } from "./store";

const log = logger.scoped("ms-teams").log;

export interface DoctorReport {
    idbExists: boolean;
    idbPath: string;
    blobExists: boolean;
    cacheExists: boolean;
    cacheReadable: boolean;
    cachePath: string;
    cacheIngestedAt: string | null;
    counts: { conversations: number; messages: number; people: number; calls: number; activity: number } | null;
    venvPythonExists: boolean;
    teamsProcess: boolean;
    readable: boolean;
}

export function inspectDoctor(): DoctorReport {
    const idbPath = liveIdbDir();
    const blobPath = liveBlobDir();
    const cachePath = cacheDbPath();
    const idbExists = existsSync(idbPath);
    let readable = false;

    if (idbExists) {
        try {
            statSync(join(idbPath, "CURRENT"));
            readable = true;
        } catch {
            readable = false;
        }
    }

    let counts: DoctorReport["counts"] = null;
    let cacheIngestedAt: string | null = null;
    let cacheReadable = false;
    const cacheExists = existsSync(cachePath);

    if (cacheExists) {
        let cache: TeamsCache | null = null;

        try {
            cache = new TeamsCache(cachePath, { readonly: true });
            counts = cache.counts();
            cacheIngestedAt = cache.getMeta("ingested_at");
            cacheReadable = true;
        } catch (err) {
            log.warn({ err, cachePath }, "[ms-teams] doctor could not open the SQLite cache");
            counts = null;
            cacheIngestedAt = null;
        } finally {
            cache?.close();
        }
    }

    return {
        idbExists,
        idbPath,
        blobExists: existsSync(blobPath),
        cacheExists,
        cacheReadable,
        cachePath,
        cacheIngestedAt,
        counts,
        venvPythonExists: existsSync(venvPython()),
        teamsProcess: teamsAppIsUp(),
        readable,
    };
}
