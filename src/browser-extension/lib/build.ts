import { rmSync } from "node:fs";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    type BuildInfo,
    buildIdDefine,
    missingManifestFiles,
    newBuildId,
    readBuildInfo,
    writeBuildInfo,
} from "@genesiscz/utils/browser-extension/build-info";
import { readRouterConfig } from "@genesiscz/utils/browser-router/config";
import { browserHosts } from "@genesiscz/utils/browser-router/services";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { EXTENSION_SOURCE_DIR } from "./host/install";
import { isRecord } from "./values";

export const DIST_DIR = resolve(import.meta.dirname, "..", "..", "..", "dist", "browser-extension");

const MODULE_ENTRIES = ["background.ts", "popup.ts", "options.ts", "route.ts"];
const STATIC_FILES = ["manifest.json", "popup.html", "options.html", "route.html"];
const ICONS = ["icon16.png", "icon48.png", "icon128.png"];

const log = logger.child({ component: "browser-extension/build" });

/**
 * Chromium refuses a content script it reads as non-UTF-8, and bundlers emit raw non-ASCII from
 * sources and dependencies. Escaping every non-ASCII UTF-16 unit keeps the output pure ASCII and
 * valid in strings, regex literals and identifiers alike (the YouTube extension does the same).
 */
export function asciiOnly(code: string): string {
    return code.replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function bundle({
    entrypoints,
    outDir,
    format,
    buildId,
}: {
    entrypoints: string[];
    outDir: string;
    format: "esm" | "iife";
    buildId: string;
}): Promise<string[]> {
    const result = await Bun.build({
        entrypoints: entrypoints.map((entry) => join(EXTENSION_SOURCE_DIR, entry)),
        outdir: outDir,
        target: "browser",
        format,
        splitting: false,
        minify: false,
        naming: { entry: "[name].js" },
        define: buildIdDefine(buildId),
    });

    if (!result.success) {
        throw new Error(`extension bundle failed: ${result.logs.map((entry) => String(entry)).join("\n")}`);
    }

    const written: string[] = [];

    for (const output of result.outputs) {
        await Bun.write(output.path, asciiOnly(await output.text()));
        written.push(output.path);
    }

    return written;
}

/** Written next to the manifest; the background worker builds its redirect rules from it. */
export const ROUTER_HOSTS_FILE = "router-hosts.json";

/**
 * The hosts the router config wants caught in the browser (the link host, alias hosts, dashboard
 * names) are granted in the manifest, since a redirect rule only fires on a host the extension may
 * access, and listed in `router-hosts.json` for the worker. A config change needs a rebuild and a
 * Reload; `tools browser-router status` reports an older build.
 */
async function grantRouterHosts(outDir: string): Promise<string> {
    const manifestPath = join(outDir, "manifest.json");
    const manifest: unknown = SafeJSON.parse(await Bun.file(manifestPath).text(), { strict: true });

    if (!isRecord(manifest) || !Array.isArray(manifest.host_permissions)) {
        throw new Error("manifest.json has no host_permissions array");
    }

    const wanted = browserHosts(readRouterConfig());
    const granted = [
        ...(wanted.linkHost ? [`https://${wanted.linkHost}/*`, `http://${wanted.linkHost}/*`] : []),
        ...wanted.hosts.flatMap((host) => [`http://${host}/*`, `https://${host}/*`]),
    ];
    manifest.host_permissions = [...new Set([...manifest.host_permissions, ...granted])];
    await Bun.write(manifestPath, `${SafeJSON.stringify(manifest, null, 4)}\n`);
    const hostsPath = join(outDir, ROUTER_HOSTS_FILE);
    await Bun.write(hostsPath, `${SafeJSON.stringify(wanted, null, 4)}\n`);
    log.info({ linkHost: wanted.linkHost, hosts: wanted.hosts.length }, "extension: granted router hosts");
    return hostsPath;
}

export interface Freshness {
    /** The build in `dist`, or null when there is none. */
    dist: BuildInfo | null;
    /** A build from the current sources and router config would differ from `dist`. */
    stale: boolean;
}

/**
 * Whether `dist` still matches what a build would write now: builds into a temporary folder and
 * compares the stamps, so a changed source file, dependency or router host all count.
 */
export async function extensionFreshness(): Promise<Freshness> {
    const dist = await readBuildInfo(DIST_DIR);
    const scratch = await mkdtemp(join(tmpdir(), "gt-extension-fresh-"));

    try {
        const fresh = await buildExtension({ outDir: scratch });
        return { dist, stale: dist === null || fresh.info.stamp !== dist.stamp };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

export async function buildExtension({ outDir = DIST_DIR }: { outDir?: string } = {}): Promise<{
    outDir: string;
    files: string[];
    info: BuildInfo;
}> {
    await mkdir(join(outDir, "icons"), { recursive: true });
    const buildId = newBuildId();
    const files = [
        ...(await bundle({ entrypoints: MODULE_ENTRIES, outDir, format: "esm", buildId })),
        ...(await bundle({ entrypoints: ["content.ts"], outDir, format: "iife", buildId })),
    ];

    for (const name of STATIC_FILES) {
        await copyFile(join(EXTENSION_SOURCE_DIR, name), join(outDir, name));
        files.push(join(outDir, name));
    }

    files.push(await grantRouterHosts(outDir));

    for (const name of ICONS) {
        await copyFile(join(EXTENSION_SOURCE_DIR, "icons", name), join(outDir, "icons", name));
        files.push(join(outDir, "icons", name));
    }

    const missing = await missingManifestFiles(outDir);

    if (missing.length > 0) {
        throw new Error(`the manifest points at files the build did not write: ${missing.join(", ")}`);
    }

    const info = await writeBuildInfo(outDir, buildId);
    log.info({ outDir, files: files.length, buildId }, "extension built");
    return { outDir, files, info };
}
