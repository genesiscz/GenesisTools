import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { fileHash, musicSignal } from "./process";

export const PINNED_SOUNDFONT = {
    name: "GeneralUser GS",
    version: "2.0.3",
    commit: "684543d5e5efaef08d02be50dcda8d552478fa60",
    sha256: "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe",
    licenseSha256: "7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be",
    license: "GeneralUser GS License v2.0",
    source: "https://github.com/mrbumpy409/GeneralUser-GS",
} as const;

export function soundfontPaths(): { file: string; license: string } {
    const folder = toolDataDir("music", "soundfonts", "GeneralUser-GS-2.0.3");
    return { file: join(folder, "GeneralUser-GS.sf2"), license: join(folder, "LICENSE.txt") };
}

async function verifiedDownload(remote: string, hash: string): Promise<Uint8Array> {
    const scoped = musicSignal();
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetch(remote, { signal: scoped ? AbortSignal.any([scoped, timeout]) : timeout });

    if (!response.ok) {
        throw new Error(`SoundFont download failed: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
        throw new Error(`SoundFont download checksum mismatch: ${remote}`);
    }

    return bytes;
}

/** Explicit mutation. Rendering and inspection never download an asset implicitly. */
export async function installSoundfont(): Promise<{ file: string; license: string; sha256: string }> {
    const locations = soundfontPaths();
    const base = `https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${PINNED_SOUNDFONT.commit}/`;
    const [font, license] = await Promise.all([
        verifiedDownload(`${base}GeneralUser-GS.sf2`, PINNED_SOUNDFONT.sha256),
        verifiedDownload(`${base}documentation/LICENSE.txt`, PINNED_SOUNDFONT.licenseSha256),
    ]);
    musicSignal()?.throwIfAborted();
    await mkdir(join(locations.file, ".."), { recursive: true });
    await writeFile(locations.license, license);
    await writeFile(locations.file, font);
    return { ...locations, sha256: await fileHash(locations.file) };
}

export async function verifySoundfont(file: string): Promise<string> {
    const hash = await fileHash(file);

    if (file === soundfontPaths().file) {
        if (hash !== PINNED_SOUNDFONT.sha256) {
            throw new Error("Pinned SoundFont checksum mismatch; run tools music soundfont install");
        }

        const license = await readFile(soundfontPaths().license);

        if (createHash("sha256").update(license).digest("hex") !== PINNED_SOUNDFONT.licenseSha256) {
            throw new Error("Pinned SoundFont license missing or changed; run tools music soundfont install");
        }
    }

    return hash;
}
