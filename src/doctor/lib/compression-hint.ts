import { lstatSync, opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatBytes } from "@app/doctor/lib/size";
import type { Finding } from "@app/doctor/lib/types";
import { type NativeCompressionEntry, openPaths, plan, sampleRatio } from "@genesiscz/utils/compress/transparent";
import { loadTransparentConfig } from "@genesiscz/utils/compress/transparent-config";
import { fileFlags, SF_DATALESS, underCloudRoot } from "@genesiscz/utils/fs/cloud-placeholder";
import { logger } from "@genesiscz/utils/logger";
import { getPrivateSize } from "@genesiscz/utils/macos/apfs";
import { escapeShellArg } from "@genesiscz/utils/string";

const MAX_ENTRIES = 512;
const MAX_DIRECTORIES = 64;
const MAX_SAMPLES = 32;
const BUDGET_MS = 2500;

export function compressionHintFinding(roots: Array<{ path: string; savingBytes: number }>): Finding | null {
    const best = roots.toSorted((a, b) => b.savingBytes - a.savingBytes)[0];

    if (!best || best.savingBytes <= 1_000_000_000) {
        return null;
    }

    const command = `tools compress transparent plan ${escapeShellArg(best.path)}`;
    return {
        id: "dev-transparent-compression",
        analyzerId: "dev-caches",
        title: `Transparent compression may save ${formatBytes(best.savingBytes)}`,
        detail: `Estimated saving from checked files: ${formatBytes(best.savingBytes)}. Review with ${command}`,
        severity: "cautious",
        actions: [],
        metadata: { kind: "transparent-compression", estimatedSavingBytes: best.savingBytes, command },
    };
}

interface CompressionHintReads {
    config: typeof loadTransparentConfig;
    opened: typeof openPaths;
    flags: typeof fileFlags;
    privateSize: typeof getPrivateSize;
    ratio: typeof sampleRatio;
    now: () => number;
}

/** A bounded lower estimate for the existing scan, never a recursive whole-home compression scan. */
export async function readCompressionHint(reads: Partial<CompressionHintReads> = {}): Promise<Finding | null> {
    if (process.platform !== "darwin") {
        return null;
    }

    const {
        config: readConfig,
        opened,
        flags: readFlags,
        privateSize,
        ratio,
        now,
    } = {
        config: loadTransparentConfig,
        opened: openPaths,
        flags: fileFlags,
        privateSize: getPrivateSize,
        ratio: sampleRatio,
        now: Date.now,
        ...reads,
    };
    const deadline = now() + BUDGET_MS;
    const config = await readConfig();
    const age = /^(\d+)([dhm])$/.exec(config.defaults.olderThan);

    if (!age) {
        throw new Error(`Invalid compression olderThan: ${config.defaults.olderThan}`);
    }

    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
    const open = await opened({ timeoutMs: 1000 });
    const roots = [
        ...new Set(
            Object.values(config.harnesses)
                .flatMap((harness) => harness.roots)
                .map((root) => resolve(root))
        ),
    ];
    const savings: Array<{ path: string; savingBytes: number }> = [];
    let visited = 0;
    let directories = 0;
    let sampled = 0;
    const seen = new Set<string>();

    for (const root of roots) {
        const pending = [root];
        const entries: NativeCompressionEntry[] = [];

        while (pending.length > 0 && visited < MAX_ENTRIES && directories < MAX_DIRECTORIES && now() < deadline) {
            const folder = pending.shift();

            if (!folder || seen.has(folder) || underCloudRoot(folder)) {
                continue;
            }

            seen.add(folder);
            directories++;
            try {
                if (!lstatSync(folder).isDirectory() || ((readFlags(folder) ?? SF_DATALESS) & SF_DATALESS) !== 0) {
                    continue;
                }

                const directory = opendirSync(folder);
                try {
                    while (visited < MAX_ENTRIES && now() < deadline) {
                        const child = directory.readSync();

                        if (!child) {
                            break;
                        }

                        visited++;
                        const path = join(folder, child.name);

                        if (child.isDirectory()) {
                            if (pending.length < MAX_DIRECTORIES) {
                                pending.push(path);
                            }
                        } else if (child.isFile()) {
                            const stat = lstatSync(path);
                            const flags = readFlags(path);

                            if (flags !== null && stat.isFile()) {
                                entries.push({
                                    path,
                                    size: stat.size,
                                    allocated: stat.blocks * 512,
                                    flags,
                                    ino: stat.ino,
                                    mtimeMs: stat.mtimeMs,
                                    nlink: stat.nlink,
                                });
                            }
                        }
                    }
                } finally {
                    directory.closeSync();
                }
            } catch (error) {
                logger.debug({ path: folder, error }, "Compression hint skipped an unreadable folder");
            }
        }

        const { candidates } = plan(entries, {
            olderThanMs: Number(age[1]) * units[age[2]],
            minBytes: config.defaults.minKb * 1024,
            exts: new Set(config.defaults.exts),
            open,
            now: now(),
        });
        let savingBytes = 0;

        for (const candidate of candidates) {
            if (sampled >= MAX_SAMPLES || now() >= deadline) {
                break;
            }

            if (candidate.alloc < candidate.size || (privateSize(candidate.path) ?? 0) < candidate.alloc) {
                continue;
            }

            sampled++;
            const after = Math.ceil((candidate.size * ratio(candidate.path, candidate.size)) / 4096) * 4096;

            if (Number.isFinite(after) && after <= candidate.alloc * 0.7) {
                savingBytes += candidate.alloc - after;
            }
        }

        savings.push({ path: root, savingBytes });
    }

    return compressionHintFinding(savings);
}
