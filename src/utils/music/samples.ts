import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { musicSamplesInstallCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { fileHash, musicSignal } from "./process";
import { SAMPLE_MANIFEST, type SampleSet } from "./samples-manifest";

export function samplesDir(): string {
    return toolDataDir("music", "samples");
}

/** The name a score uses for an installed sample: `<set>/<path inside the set>`. */
export function sampleNames(set?: string): string[] {
    return Object.entries(SAMPLE_MANIFEST)
        .filter(([key]) => set === undefined || key === set)
        .flatMap(([key, entry]) => entry.files.map(([path]) => `${key}/${path}`));
}

/** A score names a file of its own by path, or an installed sample by its name. Rendering never downloads. */
export function resolveSample(file: string): string {
    const own = resolve(file);

    if (existsSync(own)) {
        return own;
    }

    const installed = join(samplesDir(), file);

    if (existsSync(installed)) {
        return installed;
    }

    const set = Object.keys(SAMPLE_MANIFEST).find((key) => sampleNames(key).includes(file));

    if (set !== undefined) {
        const named = SAMPLE_MANIFEST[set].optIn === undefined ? undefined : set;
        throw new Error(`Sample ${file} is not installed; run ${musicSamplesInstallCommand(named)}`);
    }

    throw new Error(`Sample file does not exist: ${own}`);
}

export interface SampleSetState {
    set: string;
    files: number;
    installed: number;
    downloaded: number;
    megabytes: number;
    license: string;
    licenseUrl: string;
    /** Set for a set that installs only by name: the reason. */
    optIn?: string;
    folder: string;
}

async function state(set: string, downloaded: number): Promise<SampleSetState> {
    const entry = SAMPLE_MANIFEST[set];
    const folder = join(samplesDir(), set);
    return {
        set,
        files: entry.files.length,
        installed: entry.files.filter(([path]) => existsSync(join(folder, path))).length,
        downloaded,
        megabytes: Number((entry.files.reduce((sum, [, bytes]) => sum + bytes, 0) / 1e6).toFixed(1)),
        license: entry.license,
        licenseUrl: entry.licenseUrl,
        optIn: entry.optIn,
        folder,
    };
}

/** What is on disk. It reads only. */
export function listSampleSets(): Promise<SampleSetState[]> {
    return Promise.all(Object.keys(SAMPLE_MANIFEST).map((set) => state(set, 0)));
}

/** The sets one install covers: the default sets without a name, and an opt-in set only by its name. */
export function setsToInstall(only?: string): string[] {
    const sets = Object.keys(SAMPLE_MANIFEST).filter((set) =>
        only === undefined ? SAMPLE_MANIFEST[set].optIn === undefined : set === only
    );

    if (sets.length === 0) {
        throw new Error(`Unknown sample set ${only}; choose ${Object.keys(SAMPLE_MANIFEST).join(", ")}`);
    }

    return sets;
}

/** One file of a set: kept when its hash matches, else fetched, checked and renamed in. True when it downloaded. */
async function installSample(options: {
    entry: SampleSet;
    folder: string;
    file: SampleSet["files"][number];
    signal: AbortSignal;
}): Promise<boolean> {
    const { entry } = options;
    const [path, , sha256] = options.file;
    const file = join(options.folder, path);

    if (existsSync(file) && (await fileHash(file)) === sha256) {
        return false;
    }

    const scoped = musicSignal();
    const timeout = AbortSignal.timeout(120_000);
    const remote = `https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${entry.folder}${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    const response = await fetch(remote, {
        signal: AbortSignal.any(scoped ? [scoped, timeout, options.signal] : [timeout, options.signal]),
    });

    if (!response.ok) {
        throw new Error(`Sample download failed: HTTP ${response.status} for ${remote}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
        throw new Error(`Sample download checksum mismatch: ${remote}`);
    }

    await mkdir(dirname(file), { recursive: true });
    const staging = `${file}.${randomUUID()}.part`;

    try {
        await writeFile(staging, bytes);
        await rename(staging, file);
    } catch (error) {
        await rm(staging, { force: true });
        throw error;
    }

    return true;
}

/**
 * Explicit mutation: fetch every file of the pinned sets that is missing or changed, and keep one only when its
 * SHA-256 matches the manifest. A file lands by rename from its own staging file, so a reader never sees a partial
 * sample and two installs never share one. The first failure stops the downloads; the call returns only after every
 * download settled, and the verified files stay for the next attempt.
 */
export async function installSamples(only?: string): Promise<SampleSetState[]> {
    const sets = setsToInstall(only);
    const result: SampleSetState[] = [];

    for (const set of sets) {
        const entry = SAMPLE_MANIFEST[set];
        const folder = join(samplesDir(), set);
        const queue = [...entry.files];
        let downloaded = 0;
        const stop = new AbortController();
        const failures: unknown[] = [];

        await Promise.all(
            Array.from({ length: 8 }, async () => {
                try {
                    while (!stop.signal.aborted) {
                        const next = queue.pop();

                        if (next === undefined) {
                            break;
                        }

                        if (await installSample({ entry, folder, file: next, signal: stop.signal })) {
                            downloaded++;
                        }
                    }
                } catch (error) {
                    failures.push(error);
                    stop.abort();
                }
            })
        );

        if (failures.length > 0) {
            // The first failure is the cause; the rest are downloads it stopped.
            throw failures[0];
        }

        result.push(await state(set, downloaded));
    }

    return result;
}
