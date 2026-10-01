import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/** Written next to the manifest: which build this is, and a stamp of what it contains. */
export const BUILD_INFO_FILE = "build.json";

export interface BuildInfo {
    /** Random per build, and compiled into the bundles as `__GT_BUILD__`: the loaded code knows its own. */
    buildId: string;
    /** sha256 of every file the build wrote, the build id taken out, so two builds of the same inputs match. */
    stamp: string;
    builtAt: string;
}

export function newBuildId(): string {
    return randomUUID();
}

/** What a bundler defines so `RUNNING_BUILD` (`runtime/freshness.ts`) is this build's id. */
export function buildIdDefine(buildId: string): Record<string, string> {
    return { __GT_BUILD__: SafeJSON.stringify(buildId, { strict: true }) };
}

/** The stamp of a build folder: every file but `build.json`, with the build id blanked out. */
export async function buildStamp(outDir: string, buildId: string): Promise<string> {
    const hash = createHash("sha256");
    const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name !== BUILD_INFO_FILE)
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();

    for (const file of files) {
        const content = (await readFile(file)).toString("latin1").replaceAll(buildId, "");
        hash.update(relative(outDir, file)).update("\0").update(content, "latin1").update("\0");
    }

    return hash.digest("hex");
}

/** Stamps a finished build folder and writes its `build.json`. */
export async function writeBuildInfo(outDir: string, buildId: string): Promise<BuildInfo> {
    const info: BuildInfo = { buildId, stamp: await buildStamp(outDir, buildId), builtAt: new Date().toISOString() };
    await Bun.write(join(outDir, BUILD_INFO_FILE), `${SafeJSON.stringify(info, null, 4)}\n`);
    return info;
}

export async function readBuildInfo(outDir: string): Promise<BuildInfo | null> {
    const file = Bun.file(join(outDir, BUILD_INFO_FILE));

    if (!(await file.exists())) {
        return null;
    }

    const value: unknown = SafeJSON.parse(await file.text(), { strict: true });

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }

    const record: Record<string, unknown> = { ...value };
    return typeof record.buildId === "string" && typeof record.stamp === "string" && typeof record.builtAt === "string"
        ? { buildId: record.buildId, stamp: record.stamp, builtAt: record.builtAt }
        : null;
}

/**
 * Files the manifest names (scripts, pages, icons) that the build did not write. A missing one makes
 * Chrome show a blocking "failed to load extension" dialog, and a browser waiting on it looks exactly
 * like a hung launch, so check before loading a build anywhere.
 */
export async function missingManifestFiles(outDir: string): Promise<string[]> {
    const text = await Bun.file(join(outDir, "manifest.json")).text();
    const referenced = [...new Set([...text.matchAll(/"([\w./-]+\.(?:js|html|png|css))"/g)].map((match) => match[1]))];
    const missing: string[] = [];

    for (const file of referenced) {
        if (file && !(await Bun.file(join(outDir, file)).exists())) {
            missing.push(file);
        }
    }

    return missing;
}
