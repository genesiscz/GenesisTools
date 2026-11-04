import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { IosBuild, MobileApp } from "./types";

const log = logger.child({ component: "mobile.fingerprint" });

/** Each build input's size and modification time, keyed by its path in the app folder. */
export type BuildFingerprint = Record<string, string>;

export interface Staleness {
    stale: boolean;
    reason: string;
    /** Up to ten inputs that changed, appeared or went since the build. */
    changed: string[];
}

/** The inputs that go into a build of this configuration: the native ones, plus the JavaScript for Release. */
export function fingerprintBuild(
    app: MobileApp,
    appDir: string,
    configuration: IosBuild["configuration"]
): BuildFingerprint {
    const globs = [...app.buildInputs.native, ...(configuration === "Release" ? app.buildInputs.js : [])];
    const found: BuildFingerprint = {};

    for (const pattern of globs) {
        for (const file of new Bun.Glob(pattern).scanSync({ cwd: appDir, onlyFiles: true })) {
            const stat = statSync(join(appDir, file));
            found[file] = `${stat.size}:${Math.round(stat.mtimeMs)}`;
        }
    }

    return found;
}

function recordPath(derivedData: string, configuration: IosBuild["configuration"]): string {
    return join(derivedData, `gt-fingerprint-${configuration}.json`);
}

export function saveFingerprint(options: {
    derivedData: string;
    configuration: IosBuild["configuration"];
    fingerprint: BuildFingerprint;
}): void {
    writeFileSync(
        recordPath(options.derivedData, options.configuration),
        SafeJSON.stringify(options.fingerprint, null, 2)
    );
}

export function compareFingerprints(built: BuildFingerprint, now: BuildFingerprint): string[] {
    const keys = new Set([...Object.keys(built), ...Object.keys(now)]);
    return [...keys].filter((key) => built[key] !== now[key]).sort();
}

/** Whether the build in `derivedData` is older than its inputs, and why. */
export function buildStaleness(options: {
    app: MobileApp;
    appDir: string;
    derivedData: string;
    configuration: IosBuild["configuration"];
    appPath: string;
}): Staleness {
    if (!existsSync(options.appPath)) {
        return { stale: true, reason: `no build at ${options.appPath}`, changed: [] };
    }

    const path = recordPath(options.derivedData, options.configuration);

    if (!existsSync(path)) {
        return { stale: true, reason: "the build has no fingerprint (built by another tool)", changed: [] };
    }

    const built = SafeJSON.parse(readFileSync(path, "utf8")) as BuildFingerprint;
    const changed = compareFingerprints(built, fingerprintBuild(options.app, options.appDir, options.configuration));
    log.debug({ path, changed: changed.length }, "fingerprint compared");

    if (changed.length === 0) {
        return { stale: false, reason: "no build input changed", changed: [] };
    }

    return { stale: true, reason: `${changed.length} build input(s) changed`, changed: changed.slice(0, 10) };
}
