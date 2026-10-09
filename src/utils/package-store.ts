/// <reference path="./on-demand-packages.d.ts" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SafeJSON } from "@genesiscz/utils/json";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * The heavy ML packages live in ONE store per machine, outside every checkout, instead of in
 * package.json.
 *
 * They were on-demand once (2026-03-30), but the installer ran `bun add` in the repo, `bun add`
 * writes package.json, and that diff was committed on 2026-04-09 (d3355e14d). From then on every
 * checkout and every worktree carried about 1 GB of ML runtimes again. Installing into the store
 * never touches the repo, and all worktrees share the one copy.
 *
 * The versions are pinned here so every checkout loads the same build. A store copy at another
 * version counts as missing, and the next `ensurePackages` installs the pinned one.
 */
export const STORE_PACKAGES: Readonly<Record<string, string>> = {
    "@huggingface/inference": "4.13.28",
    "@huggingface/transformers": "4.2.0",
    "@lancedb/lancedb": "0.38.0",
    "@qdrant/js-client-rest": "1.19.0",
};

/**
 * LanceDB lists transformers 3.0.2 as an optional dependency. Without the override the store
 * would hold a second transformers and a second onnxruntime-node (about 220 MB).
 */
const STORE_OVERRIDES: Readonly<Record<string, string>> = {
    "@huggingface/transformers": STORE_PACKAGES["@huggingface/transformers"],
};

/** Same supply-chain delay as the repo's bunfig.toml: no package version younger than 7 days. */
const STORE_BUNFIG = "[install]\nminimumReleaseAge = 604800\n";

export function packageStoreDir(): string {
    return toolDataDir("packages", "store");
}

/** Held across preparing the store and the whole `bun add` (packages.ts `installStorePackages`). */
export function packageStoreInstallLock(): string {
    return join(packageStoreDir(), ".install.lock");
}

export function isStorePackage(pkg: string): boolean {
    return Object.hasOwn(STORE_PACKAGES, pkg);
}

function installedVersion(manifestPath: string): string | undefined {
    if (!existsSync(manifestPath)) {
        return undefined;
    }

    const parsed: unknown = SafeJSON.parse(readFileSync(manifestPath, "utf8"));

    if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
        return parsed.version;
    }

    return undefined;
}

export function isStorePackageInstalled(pkg: string): boolean {
    const version = installedVersion(join(packageStoreDir(), "node_modules", pkg, "package.json"));
    return version !== undefined && version === STORE_PACKAGES[pkg];
}

function readObject(path: string): Record<string, unknown> {
    if (!existsSync(path)) {
        return {};
    }

    const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
}

/**
 * Creates the store's package.json and bunfig.toml, and keeps the overrides current. Existing
 * dependencies stay as they are, so a pin change only adds the new version.
 */
export function preparePackageStore(): string {
    const dir = packageStoreDir();
    mkdirSync(dir, { recursive: true });

    const manifestPath = join(dir, "package.json");
    const manifest = readObject(manifestPath);
    manifest.name = "genesis-tools-package-store";
    manifest.private = true;
    manifest.overrides = { ...STORE_OVERRIDES };
    writeFileSync(manifestPath, `${SafeJSON.stringify(manifest, null, 4)}\n`);

    const bunfigPath = join(dir, "bunfig.toml");

    if (!existsSync(bunfigPath)) {
        writeFileSync(bunfigPath, STORE_BUNFIG);
    }

    return dir;
}

/**
 * Imports a package from the store. `from` names the store package whose copy of `specifier`
 * to load, so the onnxruntime-node probe sees the exact binary transformers.js runs.
 */
export async function importStorePackage<T>(specifier: string, options?: { from?: string }): Promise<T> {
    const base = options?.from ? join(packageStoreDir(), "node_modules", options.from) : packageStoreDir();
    let resolved: string;

    try {
        resolved = Bun.resolveSync(specifier, base);
    } catch (err) {
        throw new Error(
            `${specifier} is not installed in the package store (${packageStoreDir()}); ensurePackage() installs it`,
            { cause: err }
        );
    }

    return await import(pathToFileURL(resolved).href);
}
