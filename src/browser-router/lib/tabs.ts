import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const CAP = 15;

function bundleFile(): string {
    return `${new Storage("browser-router").getBaseDir()}/bundles.json`;
}

/** Read, add and write under one file lock: two `tabs save` runs must not each drop the other's bundle. */
export async function saveBundle(name: string, urls: string[]): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error("bundle name must be letters, numbers, _ or -");
    }

    const lock = `${bundleFile()}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    await withFileLock(lock, async () => {
        const all = readBundles();
        all[name] = urls;
        writeBundles(all);
    });
}

export function bundleUrls(name: string): string[] {
    const urls = readBundles()[name];
    if (!urls) {
        throw new Error(`no tab bundle named ${name}`);
    }
    if (urls.length > CAP) {
        throw new Error(`${name} has ${urls.length} links. Open at most ${CAP}, or split the bundle.`);
    }
    return urls;
}

function isBundleMap(value: unknown): value is Record<string, string[]> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).every((urls) => Array.isArray(urls) && urls.every((url) => typeof url === "string"));
}

/** Only a missing file means "no bundles"; an unreadable or malformed one throws, so a save cannot overwrite it. */
function readBundles(): Record<string, string[]> {
    const path = bundleFile();
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {};
        }

        throw error;
    }

    const parsed: unknown = SafeJSON.parse(text, { strict: true });

    if (!isBundleMap(parsed)) {
        throw new Error(`${path} is not a map of bundle names to link lists; fix or move it aside`);
    }

    return parsed;
}

function writeBundles(bundles: Record<string, string[]>): void {
    atomicWriteFileSync(bundleFile(), `${SafeJSON.stringify(bundles, null, 2)}\n`);
}
