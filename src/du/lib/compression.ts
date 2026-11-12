import { dirname, resolve } from "node:path";
// lint-rules-ignore: the explicit task-registration command delegates to the daemon owner; read-only scans never register or enable it.
import { ensureColdCompressTask } from "@app/macos/lib/clones/daemon-tasks";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    availableTransparentWriter,
    openPaths,
    plan,
    sampleRatio,
    UF_COMPRESSED,
} from "@genesiscz/utils/compress/transparent";
import { loadTransparentConfig } from "@genesiscz/utils/compress/transparent-config";
import { parseDuration } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { getPrivateSize } from "@genesiscz/utils/macos/apfs";
import { escapeShellArg } from "@genesiscz/utils/string";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { type CompressionFileEntry, listCompressionFiles } from "./engine";
import { humanBytes } from "./format";

export interface CompressionSuggestion {
    path: string;
    files: number;
    allocated_bytes: number;
    estimated_bytes_after: number;
    estimated_saving_bytes: number;
    command: string;
}

/** Pure grouping, with reads injected so tests can pin uncertain sharing and ratios. */
export function rankCompressible(options: {
    entries: CompressionFileEntry[];
    open: Set<string>;
    olderThanMs: number;
    minBytes: number;
    exts: Set<string>;
    maxBytes?: number;
    now: number;
    privateSize: (path: string) => number | null;
    ratio: (path: string, size: number) => number;
}): { folders: CompressionSuggestion[]; skippedShared: number; skips: ReturnType<typeof plan>["skips"] } {
    const filtered = plan(options.entries, options);
    const folders = new Map<string, CompressionSuggestion>();
    let skippedShared = 0;

    for (const candidate of filtered.candidates) {
        if (candidate.alloc < candidate.size) {
            continue;
        }
        const privateBytes = options.privateSize(candidate.path);

        // A subtree scan cannot prove that every clone elsewhere will be replaced.
        // Unknown or shared allocation earns no reclaim estimate.
        if (privateBytes === null || privateBytes < candidate.alloc) {
            skippedShared++;
            continue;
        }

        const ratio = options.ratio(candidate.path, candidate.size);
        const after = Math.ceil((candidate.size * ratio) / 4096) * 4096;

        if (!Number.isFinite(after) || after > candidate.alloc * 0.7) {
            continue;
        }

        const folder = dirname(candidate.path);
        const row = folders.get(folder) ?? {
            path: folder,
            files: 0,
            allocated_bytes: 0,
            estimated_bytes_after: 0,
            estimated_saving_bytes: 0,
            command: `${toolCommand("compress transparent apply")} ${escapeShellArg(folder)}`,
        };
        row.files++;
        row.allocated_bytes += candidate.alloc;
        row.estimated_bytes_after += after;
        row.estimated_saving_bytes += candidate.alloc - after;
        folders.set(folder, row);
    }

    return {
        folders: [...folders.values()].sort((a, b) => b.estimated_saving_bytes - a.estimated_saving_bytes),
        skippedShared,
        skips: filtered.skips,
    };
}

export async function compressionSuggestions(root: string) {
    const config = await loadTransparentConfig();
    const age = parseDuration(config.defaults.olderThan);

    if (!Number.isFinite(age) || age <= 0) {
        throw new Error(`Invalid compression olderThan: ${config.defaults.olderThan}`);
    }

    const writer = availableTransparentWriter();
    const algorithm = writer.algorithm;
    const [entries, open] = await Promise.all([listCompressionFiles(root), openPaths()]);
    const ranked = rankCompressible({
        entries,
        open,
        olderThanMs: age,
        minBytes: config.defaults.minKb * 1024,
        maxBytes: writer.maxBytes,
        exts: new Set(config.defaults.exts),
        now: Date.now(),
        privateSize: getPrivateSize,
        ratio: (path, size) => sampleRatio(path, size, algorithm),
    });
    return { ...ranked, algorithm };
}

export async function compressedListing(root: string) {
    const files = (await listCompressionFiles(root)).filter((file) => (file.flags & UF_COMPRESSED) !== 0);
    const compressed = files.reduce(
        (sum, file) => ({
            files: sum.files + 1,
            logical_bytes: sum.logical_bytes + file.size,
            allocated_bytes: sum.allocated_bytes + file.allocated,
        }),
        { files: 0, logical_bytes: 0, allocated_bytes: 0 }
    );
    return { path: root, compressed, files };
}

export function registerCompressionCommands(program: Command): void {
    program
        .command("compression-schedule")
        .description("Register the daily compression task disabled; never enables it")
        .action(async () => {
            out.result({
                task: "du-cold-compress",
                written: await ensureColdCompressTask(),
                enabledByThisCommand: false,
            });
        });
    program
        .command("compressed")
        .description("List files carrying the APFS compressed flag, read-only")
        .argument("<dir>")
        .option("--json", "Print JSON")
        .action(async (dir: string, options: { json?: boolean }) => {
            const result = await compressedListing(resolve(dir));

            if (options.json) {
                out.result(result);
                return;
            }

            const table = createBoxTable(["FILE", "LOGICAL", "ALLOCATED"]);
            for (const file of result.files) {
                table.push([file.path, humanBytes(file.size), humanBytes(file.allocated)]);
            }
            out.println(table.toString());
        });
    program
        .command("compressible")
        .description("Rank folders by estimated transparent compression savings, read-only")
        .argument("<dir>")
        .option("--json", "Print JSON")
        .action(async (dir: string, options: { json?: boolean }) => {
            const result = await compressionSuggestions(resolve(dir));
            logger.debug(
                { root: dir, folders: result.folders.length, skippedShared: result.skippedShared },
                "du: estimated compression"
            );

            if (options.json) {
                out.result({ ...result, estimate: true });
                return;
            }

            const table = createBoxTable(["FOLDER", "FILES", "ON DISK", "EST. AFTER", "EST. SAVING"]);
            for (const folder of result.folders) {
                table.push([
                    folder.path,
                    String(folder.files),
                    humanBytes(folder.allocated_bytes),
                    humanBytes(folder.estimated_bytes_after),
                    humanBytes(folder.estimated_saving_bytes),
                ]);
            }
            out.println(table.toString());
            for (const folder of result.folders) {
                out.println(folder.command);
            }
            out.println(
                `Estimate uses first and middle 1 MiB, ${result.algorithm}. Shared or unknown allocation skipped: ${result.skippedShared} files.`
            );
        });
}
