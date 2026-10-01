import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Marker Electron writes in front of the sealed ElectronAsarIntegrity digest. */
export const INTEGRITY_DICTIONARY_SENTINEL = "AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A";

export interface IntegrityDictionaryEntry {
    path: string;
    algorithm: string;
    hash: string;
}

/**
 * SHA256 of the Info.plist ElectronAsarIntegrity dictionary.
 * Electron compares this to a 32-byte slot in the framework binary and aborts
 * when the plist hash changes and the slot does not.
 */
export function integrityDictionaryDigest(entries: readonly IntegrityDictionaryEntry[]): Buffer {
    const hash = createHash("sha256");
    const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (const entry of sorted) {
        hash.update(entry.path);
        hash.update(entry.algorithm);
        hash.update(entry.hash);
    }

    return hash.digest();
}

function taggedDict(plist: string, key: string): string | undefined {
    const start = plist.indexOf(`<key>${key}</key>`);
    if (start < 0) {
        return undefined;
    }

    const dictAt = plist.indexOf("<dict>", start);
    if (dictAt < 0) {
        return undefined;
    }

    let depth = 0;
    for (let index = dictAt; index < plist.length; index += 1) {
        if (plist.startsWith("<dict>", index)) {
            depth += 1;
            index += "<dict>".length - 1;
            continue;
        }

        if (plist.startsWith("</dict>", index)) {
            depth -= 1;
            if (depth === 0) {
                return plist.slice(dictAt, index + "</dict>".length);
            }

            index += "</dict>".length - 1;
        }
    }

    return undefined;
}

export function electronAsarIntegrityEntries(plist: string): IntegrityDictionaryEntry[] {
    const block = taggedDict(plist, "ElectronAsarIntegrity");
    if (!block) {
        throw new Error("Info.plist has no ElectronAsarIntegrity dictionary");
    }

    const entries: IntegrityDictionaryEntry[] = [];
    const pattern = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
    for (const match of block.matchAll(pattern)) {
        const body = match[2] ?? "";
        const path = match[1];
        const algorithm = /<key>algorithm<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1];
        const hash = /<key>hash<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1];
        if (!path || !algorithm || !hash) {
            continue;
        }

        entries.push({ path, algorithm, hash });
    }

    if (entries.length === 0) {
        throw new Error("ElectronAsarIntegrity has no hashes");
    }

    return entries;
}

function plistExecutable(plistPath: string): string | undefined {
    if (!existsSync(plistPath)) {
        return undefined;
    }

    const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/.exec(
        readFileSync(plistPath, "utf8")
    )?.[1];

    return executable || undefined;
}

/** The Electron framework binary that carries the asar integrity digest slot. */
export function locateIntegrityDigestBinary(appPath: string): string {
    const frameworks = join(appPath, "Contents", "Frameworks");
    if (!existsSync(frameworks)) {
        throw new Error(`${appPath} has no Electron framework with an asar integrity digest`);
    }

    const sentinel = Buffer.from(INTEGRITY_DICTIONARY_SENTINEL);
    for (const name of readdirSync(frameworks)) {
        if (!name.endsWith(".framework")) {
            continue;
        }

        const framework = join(frameworks, name);
        const executableName =
            plistExecutable(join(framework, "Resources", "Info.plist")) ??
            plistExecutable(join(framework, "Versions", "Current", "Resources", "Info.plist"));
        if (!executableName) {
            continue;
        }

        const candidates = [join(framework, "Versions", "Current", executableName), join(framework, executableName)];
        for (const candidate of candidates) {
            if (!existsSync(candidate)) {
                continue;
            }

            if (readFileSync(candidate).includes(sentinel)) {
                return candidate;
            }
        }
    }

    throw new Error(`${appPath} has no Electron framework with an asar integrity digest`);
}

export function writeIntegrityDictionaryDigest(binaryPath: string, digest: Buffer): void {
    if (digest.length !== 32) {
        throw new Error("asar integrity digest must be 32 bytes");
    }

    const data = readFileSync(binaryPath);
    const sentinel = Buffer.from(INTEGRITY_DICTIONARY_SENTINEL);
    const indexes: number[] = [];
    let from = 0;
    while (from < data.length) {
        const found = data.indexOf(sentinel, from);
        if (found < 0) {
            break;
        }

        indexes.push(found);
        from = found + sentinel.length;
    }

    if (indexes.length !== 1) {
        throw new Error(`expected one asar integrity digest in ${binaryPath}, found ${indexes.length}`);
    }

    const at = indexes[0] ?? 0;
    if (data[at + 32] !== 1 || data[at + 33] !== 1) {
        throw new Error(`${binaryPath} asar integrity digest slot is unused`);
    }

    const current = data.subarray(at + 34, at + 66);
    if (current.equals(digest)) {
        return;
    }

    const next = Buffer.from(data);
    digest.copy(next, at + 34);
    writeFileSync(binaryPath, next);
}
