import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { untarGz } from "@app/utils/fs";
import { verifySriIntegrity } from "@app/utils/hash";
import { SafeJSON } from "@app/utils/json";
import { assertSafePathSegment } from "@app/utils/paths";
import { Storage } from "@app/utils/storage/storage";
import { beautify } from "./beautify";
import { extractBunModules } from "./bun-binary";
import { normalizeIdentifiers } from "./normalize";
import {
    type Fetcher,
    fetchManifest,
    fetchPackument,
    hostPlatform,
    MAIN_PKG,
    type Packument,
    platformPkg,
} from "./registry";

export interface EnsureBundleArgs {
    version: string;
    platform?: string;
    force?: boolean;
    fetcher?: Fetcher;
}

export interface BundleMeta {
    version: string;
    platform: string;
    source: "platform-pkg" | "main-pkg";
    entrypoint: string;
    modules: Array<{ name: string; file?: string; bytes: number; loader: number }>;
    extractedAt: string;
}

export interface BundleRef {
    version: string;
    platform: string;
    dir: string;
    entrypointPath: string;
    meta: BundleMeta;
}

const storage = new Storage("claude-code");
const PACKUMENT_TTL_MS = 60 * 60 * 1000;

export async function cachedPackument({
    fetcher = fetch,
    force = false,
}: {
    fetcher?: Fetcher;
    force?: boolean;
} = {}): Promise<Packument> {
    const cachePath = join(storage.getCacheDir(), "packument.json");

    if (!force && existsSync(cachePath)) {
        const cached = SafeJSON.parse(await Bun.file(cachePath).text()) as
            | { fetchedAt?: string; packument?: Packument }
            | null
            | undefined;

        if (cached?.fetchedAt && cached?.packument && Date.now() - Date.parse(cached.fetchedAt) < PACKUMENT_TTL_MS) {
            return cached.packument;
        }
    }

    const packument = await fetchPackument({ pkg: MAIN_PKG, fetcher });
    mkdirSync(storage.getCacheDir(), { recursive: true });
    await Bun.write(cachePath, SafeJSON.stringify({ fetchedAt: new Date().toISOString(), packument }, null, 2) ?? "{}");
    return packument;
}

async function downloadTarball({
    url,
    integrity,
    fetcher,
}: {
    url: string;
    integrity?: string;
    fetcher: Fetcher;
}): Promise<Uint8Array> {
    logger.info(`downloading ${url}`);
    const res = await fetcher(url);

    if (!res.ok) {
        throw new Error(`download failed ${res.status}: ${url}`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const verification = verifySriIntegrity(bytes, integrity);

    switch (verification.status) {
        case "missing":
            logger.warn({ url }, "no integrity hash provided by registry — tarball contents unverified");
            break;
        case "unsupported":
            logger.warn(
                { url, algorithm: verification.algorithm },
                "unsupported integrity hash algorithm — tarball contents unverified"
            );
            break;
        case "mismatch":
            throw new Error(
                `integrity mismatch for ${url}: expected ${verification.expected}, got ${verification.actual}`
            );
        case "verified":
            break;
    }

    logger.debug({ bytes: bytes.length, url }, "tarball downloaded");
    return bytes;
}

export async function ensureBundle({
    version,
    platform = hostPlatform(),
    force = false,
    fetcher = fetch,
}: EnsureBundleArgs): Promise<BundleRef> {
    assertSafePathSegment(version, "version");
    assertSafePathSegment(platform, "platform");
    const dir = join(storage.getCacheDir(), "bundles", `${version}-${platform}`);
    const metaPath = join(dir, "meta.json");

    if (!force && existsSync(metaPath)) {
        const meta = SafeJSON.parse(await Bun.file(metaPath).text()) as BundleMeta | null | undefined;

        if (meta?.entrypoint) {
            logger.debug({ version, platform, dir }, "bundle cache hit");
            return { version, platform, dir, entrypointPath: join(dir, meta.entrypoint), meta };
        }
    }

    const mainManifest = await fetchManifest({ pkg: MAIN_PKG, version, fetcher });

    if (!mainManifest?.dist?.tarball) {
        throw new Error(`failed to fetch or parse manifest for ${MAIN_PKG}@${version}`);
    }

    const mainTarball = untarGz(
        await downloadTarball({ url: mainManifest.dist.tarball, integrity: mainManifest.dist.integrity, fetcher })
    );
    let source: BundleMeta["source"];
    let jsModules: Array<{ name: string; contents: Uint8Array; loader: number; isEntrypoint: boolean }>;
    const oldStyle = mainTarball.get("package/cli.js");

    if (oldStyle !== undefined) {
        source = "main-pkg";
        jsModules = [{ name: "package/cli.js", contents: oldStyle, loader: 1, isEntrypoint: true }];
    } else {
        source = "platform-pkg";
        const pkg = platformPkg(platform);

        if (mainManifest.optionalDependencies?.[pkg] === undefined) {
            throw new Error(
                `${MAIN_PKG}@${version} has no cli.js and no optionalDependency ${pkg} — pass --platform with one of: ${Object.keys(mainManifest.optionalDependencies ?? {}).join(", ")}`
            );
        }

        const nativeManifest = await fetchManifest({ pkg, version, fetcher });

        if (!nativeManifest?.dist?.tarball) {
            throw new Error(`failed to fetch or parse manifest for ${pkg}@${version}`);
        }

        const nativeTarball = untarGz(
            await downloadTarball({
                url: nativeManifest.dist.tarball,
                integrity: nativeManifest.dist.integrity,
                fetcher,
            })
        );
        const binary = nativeTarball.get("package/claude") ?? nativeTarball.get("package/claude.exe");

        if (binary === undefined) {
            throw new Error(
                `no package/claude binary in ${pkg}@${version} (entries: ${[...nativeTarball.keys()].join(", ")})`
            );
        }

        jsModules = extractBunModules(binary).filter((m) => m.loader !== 10);
    }

    mkdirSync(dir, { recursive: true });
    const modules: BundleMeta["modules"] = [];
    let entrypoint = "";

    const usedFiles = new Set<string>();
    const orderedModules = [...jsModules].sort((a, b) => Number(b.isEntrypoint) - Number(a.isEntrypoint));

    for (const m of orderedModules) {
        const base = m.isEntrypoint
            ? "cli.js"
            : m.name.replace(/^\/\$bunfs\/root\//, "").replace(/[^a-zA-Z0-9.-]/g, "_");
        let file = base;
        let suffix = 0;

        while (usedFiles.has(file)) {
            suffix += 1;
            file = `${base}.${suffix}`;
        }

        usedFiles.add(file);
        await Bun.write(join(dir, file), m.contents);
        modules.push({ name: m.name, file, bytes: m.contents.length, loader: m.loader });

        if (m.isEntrypoint) {
            entrypoint = file;
        }
    }

    if (entrypoint === "") {
        throw new Error(
            `no entrypoint module found for ${version} (modules: ${modules.map((m) => m.name).join(", ")})`
        );
    }

    const meta: BundleMeta = { version, platform, source, entrypoint, modules, extractedAt: new Date().toISOString() };
    await Bun.write(metaPath, SafeJSON.stringify(meta, null, 2) ?? "{}");
    logger.info(`extracted ${version} (${source}) → ${dir}`);
    return { version, platform, dir, entrypointPath: join(dir, entrypoint), meta };
}

async function ensureDerived({
    ref,
    file,
    raw,
    produce,
}: {
    ref: BundleRef;
    file: string;
    raw?: string;
    produce: (raw: string) => Promise<string> | string;
}): Promise<string> {
    const path = join(ref.dir, file);

    if (existsSync(path)) {
        return Bun.file(path).text();
    }

    const input = raw ?? (await Bun.file(ref.entrypointPath).text());
    const derived = await produce(input);
    await Bun.write(path, derived);
    logger.debug({ file, version: ref.version, bytes: derived.length }, "derived artifact cached");
    return derived;
}

export async function ensureBeautified(ref: BundleRef): Promise<string> {
    return ensureDerived({ ref, file: "beautified.js", produce: (raw) => beautify(raw) });
}

export async function ensureNormalized(ref: BundleRef): Promise<string> {
    const beautified = await ensureBeautified(ref);
    return ensureDerived({
        ref,
        file: "normalized.js",
        raw: beautified,
        produce: (raw) => normalizeIdentifiers(raw, `${ref.version}.js`),
    });
}
