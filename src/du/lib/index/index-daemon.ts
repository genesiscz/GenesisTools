#!/usr/bin/env bun
// The nightly `du-index-refresh` task (registered by `tools du index schedule --on`).
// A full build, not an update sweep: only a full walk sees the file growth that
// FSEvents missed (dropped events, MustScanSubDirs). It rebuilds the default index
// with the options of its last build, or indexes $HOME when there is none yet.

import { existsSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { buildIndex, INDEX_DEFAULTS } from "./build";
import { allMeta, defaultDbPath, openIndexDbForRead } from "./db";
import { errorEvent, IndexError } from "./types";

const log = logger.child({ component: "du:index:daemon" });

function lastBuildOptions(dbPath: string): Record<string, string> {
    if (!existsSync(dbPath)) {
        return {};
    }

    const db = openIndexDbForRead(dbPath);
    try {
        return allMeta(db);
    } finally {
        db.close();
    }
}

async function main(): Promise<void> {
    const dbPath = defaultDbPath();
    try {
        const meta = lastBuildOptions(dbPath);
        const result = await buildIndex({
            db: dbPath,
            root: meta.root ?? env.paths.getHome(),
            private: meta.private !== "0",
            minDirBytes: Number(meta.min_dir_bytes ?? INDEX_DEFAULTS.minDirBytes),
            bigFileFloor: Number(meta.big_file_floor ?? INDEX_DEFAULTS.bigFileFloor),
            snapshotFloor: Number(meta.snapshot_floor ?? INDEX_DEFAULTS.snapshotFloor),
            excludes: SafeJSON.parse(meta.excludes ?? "[]", { strict: true }) as string[],
            includeCloud: meta.include_cloud === "1",
        });
        out.print(`${SafeJSON.stringify(result, { strict: true })}\n`);
    } catch (err) {
        const e =
            err instanceof IndexError
                ? err
                : new IndexError("failed", err instanceof Error ? err.message : String(err));
        log.error({ err, code: e.code }, "nightly du index build failed");
        out.print(`${SafeJSON.stringify(errorEvent("build", e), { strict: true })}\n`);
        process.exitCode = e.exitCode;
    }
}

await main();
