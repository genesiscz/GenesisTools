#!/usr/bin/env bun
/**
 * Does the frame walker cost performance? Bun 1.3.13's `node:zlib` zstd stream returns only the first frame of a
 * multi-frame file, so `@genesiscz/utils/compress` decodes frame by frame. This bench reads the SAME real seekable
 * `.zst` files three ways, each sample in a fresh process, arms interleaved:
 *   walker   readZstdFrames (frames decoded on the thread pool, 4 ahead, in file order)
 *   native   fs.createReadStream(file).pipe(zlib.createZstdDecompress())
 *   oneshot  Bun.zstdDecompressSync(readFileSync(file)) (whole file in memory, the upper bound for speed)
 * Two modes: `full` reads every byte (sha256 must agree between the arms), `tail` needs only the last frame (the
 * walker reads it from the end; the other two must decode the whole file to reach it).
 * Wall (parent, spawn to exit), CPU (child rusage) and peak RSS (child maxRSS); medians per arm.
 *
 * Usage: bun scripts/benchmarks/compress/native-stream.ts [--runs 7] [--json]
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";

import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { readZstdFrames, zstdContentBytes, zstdFrames } from "@genesiscz/utils/compress/zstd";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

const ARMS = ["walker", "native", "oneshot"] as const;
type Arm = (typeof ARMS)[number];
type Mode = "full" | "tail";

interface Sample {
    bytes: number;
    sha: string;
    cpuMs: number;
    maxRssMB: number;
}

async function child(arm: Arm, mode: Mode, file: string): Promise<Sample> {
    const hash = createHash("sha256");
    let bytes = 0;
    // The file's last 64 KiB, whatever chunk sizes an arm yields: the newest chunks that cover it, no copying per chunk.
    const recent: Uint8Array[] = [];
    let recentBytes = 0;
    const take = (chunk: Uint8Array) => {
        bytes += chunk.length;
        if (mode === "full") {
            hash.update(chunk);
            return;
        }

        recent.push(chunk);
        recentBytes += chunk.length;
        while (recent.length > 1 && recentBytes - recent[0]!.length >= 65_536) {
            recentBytes -= recent.shift()!.length;
        }
    };

    if (arm === "walker") {
        for await (const frame of readZstdFrames(file, { fromEnd: mode === "tail" })) {
            take(frame);
            if (mode === "tail") {
                break;
            }
        }
    } else if (arm === "native") {
        for await (const chunk of createReadStream(file).pipe(createZstdDecompress())) {
            take(chunk as Uint8Array);
        }
    } else {
        take(Bun.zstdDecompressSync(readFileSync(file)));
    }

    const tail = Buffer.concat(recent).subarray(-65_536);
    const sha = mode === "full" ? hash.digest("hex") : createHash("sha256").update(tail).digest("hex");
    const usage = process.resourceUsage();
    return {
        bytes,
        sha,
        cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
        maxRssMB: usage.maxRSS / 1024,
    };
}

function frameCount(file: string): number {
    const fd = openSync(file, "r");
    try {
        return zstdFrames(fd, fstatSync(fd).size).length;
    } finally {
        closeSync(fd);
    }
}

/** The largest seekable (multi-frame) day log, a transcript day and a migrate-home archive, all real and read-only. */
function pickFiles(): { label: string; file: string }[] {
    const home = genesisToolsDir();
    const largest = (dir: string, match: RegExp) =>
        readdirSync(dir, { recursive: true, encoding: "utf8" })
            .filter((name) => match.test(name))
            .map((name) => join(dir, name))
            .filter((file) => frameCount(file) > 1)
            .map((file) => ({ file, content: zstdContentBytes(file) ?? 0 }))
            .sort((a, b) => b.content - a.content)[0]?.file;
    const picks = [
        { label: "day log", file: largest(join(home, "logs"), /^\d{4}-\d{2}-\d{2}\.log\.zst$/) },
        { label: "transcript", file: largest(join(home, "ai-proxy", "transcripts"), /\.jsonl\.zst$/) },
        { label: "migrate-home", file: largest(join(home, "codex", "migrate-home"), /^\d{8}-\d{6}\.zst$/) },
    ];
    return picks.filter((pick): pick is { label: string; file: string } => Boolean(pick.file));
}

const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function parent(): Promise<void> {
    const args = process.argv.slice(2);
    const runs = Number(args[args.indexOf("--runs") + 1]) || 7;
    const json = args.includes("--json");
    const results: Record<string, unknown>[] = [];
    out.log.info(
        `Bun ${Bun.version}, ${runs} runs per arm, load ${(await Bun.$`uptime`.text()).trim().split("load averages: ")[1]}`
    );

    for (const { label, file } of pickFiles()) {
        const content = zstdContentBytes(file) ?? 0;
        for (const mode of ["full", "tail"] as const) {
            const samples: Record<Arm, (Sample & { wallMs: number })[]> = { walker: [], native: [], oneshot: [] };
            for (let run = 0; run < runs; run++) {
                for (const arm of ARMS) {
                    const start = performance.now();
                    const proc = Bun.spawnSync(["bun", import.meta.path, "--child", arm, mode, file], {
                        stdout: "pipe",
                        stderr: "pipe",
                    });
                    const wallMs = performance.now() - start;
                    if (proc.exitCode !== 0) {
                        throw new Error(`${arm} ${mode} ${label}: ${proc.stderr.toString().slice(0, 300)}`);
                    }

                    samples[arm].push({
                        ...(SafeJSON.parse(proc.stdout.toString(), { strict: true }) as Sample),
                        wallMs,
                    });
                }
            }

            const shas = new Set(ARMS.map((arm) => samples[arm][0]?.sha));
            const row: Record<string, unknown> = {
                file: label,
                mode,
                frames: frameCount(file),
                contentMB: +(content / 1e6).toFixed(1),
                outputsAgree: shas.size === 1,
            };
            for (const arm of ARMS) {
                row[`${arm}Bytes`] = samples[arm][0]?.bytes;
                row[`${arm}WallMs`] = Math.round(median(samples[arm].map((s) => s.wallMs)));
                row[`${arm}CpuMs`] = Math.round(median(samples[arm].map((s) => s.cpuMs)));
                row[`${arm}RssMB`] = Math.round(median(samples[arm].map((s) => s.maxRssMB)));
            }

            results.push(row);
            if (!json) {
                out.println(SafeJSON.stringify(row));
            }
        }
    }

    if (json) {
        out.result(results);
    }
}

if (process.argv[2] === "--child") {
    const [, arm, mode, file] = process.argv.slice(2);
    process.stdout.write(SafeJSON.stringify(await child(arm as Arm, mode as Mode, file)));
} else {
    await parent();
}
