#!/usr/bin/env bun
/**
 * Saving and speed of each compression setting on each kind of data, which is where the preset defaults in
 * `src/utils/compress/presets.ts` come from. Every sample is at most 64 MiB, cut into the setting's frames the way
 * the seekable writer cuts them, compressed on one thread (CPU ms from `process.cpuUsage`), then decompressed.
 *
 * Data, all read-only and none of it private: the repo's own TypeScript (text), the newest plain day log (JSONL), the
 * tar stream of `src/utils` and of `node_modules/typescript` (trees), the `biome` executable (binary), a SQLite file
 * generated here (database), and random bytes (already-compressed media; real photos and video measured 0.2-1.9%
 * on 2026-10-13, see README.md).
 *
 * Usage: bun scripts/benchmarks/compress/presets.ts [--baseline] [--json]
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { sampleFolder } from "@genesiscz/utils/compress/operations";
import { compressFrameSync, decompressBytes } from "@genesiscz/utils/compress/zstd";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { listDayLogs } from "@genesiscz/utils/logger/day-logs";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { finishBench, parseBenchArgs } from "../fs/shared";

const REPO = join(import.meta.dir, "..", "..", "..");
const SAMPLE = 64 * 1024 * 1024;
const MiB = 1024 * 1024;

const SETTINGS = [
    { name: "level1", level: 1, long: false, frameBytes: 4 * MiB },
    { name: "level3", level: 3, long: false, frameBytes: 4 * MiB },
    { name: "level6", level: 6, long: false, frameBytes: 4 * MiB },
    { name: "level6-long-32M", level: 6, long: true, frameBytes: 32 * MiB },
    { name: "level9", level: 9, long: false, frameBytes: 4 * MiB },
    { name: "level19-long-32M", level: 19, long: true, frameBytes: 32 * MiB },
] as const;

function concatFiles(root: string, pattern: RegExp, limit: number): Buffer {
    const chunks: Buffer[] = [];
    let total = 0;
    const stack = [root];

    while (stack.length > 0 && total < limit) {
        const dir = stack.pop()!;

        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);

            if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
                stack.push(path);
            } else if (entry.isFile() && pattern.test(entry.name)) {
                const bytes = readFileSync(path);
                chunks.push(bytes);
                total += bytes.length;
            }
        }
    }

    return Buffer.concat(chunks).subarray(0, limit);
}

function sqliteFixture(): Buffer {
    const dir = join(tmpdir(), "gt-bench-compress");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "presets-fixture.sqlite");

    if (!existsSync(path)) {
        const db = new Database(path);
        db.run("CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT, kind TEXT, payload TEXT)");
        const insert = db.prepare("INSERT INTO events (at, kind, payload) VALUES (?, ?, ?)");
        db.transaction(() => {
            for (let index = 0; index < 200_000; index++) {
                insert.run(
                    new Date(1_790_000_000_000 + index * 1000).toISOString(),
                    `kind-${index % 17}`,
                    SafeJSON.stringify({ index, tool: `tool-${index % 40}`, ok: index % 9 !== 0, ms: index % 997 })
                );
            }
        })();
        db.run("CREATE INDEX events_kind ON events(kind)");
        db.close();
    }

    return readFileSync(path).subarray(0, SAMPLE);
}

async function samples(): Promise<Record<string, Buffer>> {
    // The newest plain day before today that fills a sample (a test once leaked a `2027-01-15.log`).
    const today = new Date().toISOString().slice(0, 10);
    const newestDay = listDayLogs().find(
        (file) => !file.compressed && file.day < today && statSync(file.path).size > SAMPLE
    );
    const biome = join(REPO, "node_modules", "@biomejs", "cli-darwin-arm64", "biome");

    return {
        "text (repo .ts)": concatFiles(join(REPO, "src"), /\.ts$/, SAMPLE),
        "jsonl (day log)": newestDay ? readFileSync(newestDay.path).subarray(0, SAMPLE) : Buffer.alloc(0),
        "tree (src/utils tar)": Buffer.from(await sampleFolder(join(REPO, "src", "utils"), SAMPLE)),
        "tree (typescript tar)": Buffer.from(await sampleFolder(join(REPO, "node_modules", "typescript"), SAMPLE)),
        "binary (biome)": existsSync(biome) ? readFileSync(biome).subarray(0, SAMPLE) : Buffer.alloc(0),
        "database (sqlite)": sqliteFixture(),
        "media (random)": Buffer.from(crypto.getRandomValues(new Uint8Array(16 * MiB))),
    };
}

interface Measured {
    saving: number;
    compressMbS: number;
    decompressMbS: number;
}

function measure(data: Buffer, setting: (typeof SETTINGS)[number]): Measured {
    let compressed = 0;
    let compressCpu = 0;
    let decompressCpu = 0;

    for (let at = 0; at < data.length; at += setting.frameBytes) {
        const frame = data.subarray(at, at + setting.frameBytes);
        const c0 = process.cpuUsage();
        const out = compressFrameSync(frame, { level: setting.level, long: setting.long });
        const c1 = process.cpuUsage(c0);
        compressCpu += c1.user + c1.system;
        const d0 = process.cpuUsage();
        decompressBytes(out);
        const d1 = process.cpuUsage(d0);
        decompressCpu += d1.user + d1.system;
        compressed += out.length;
    }

    const mb = data.length / 1e6;
    return {
        saving: 1 - compressed / Math.max(data.length, 1),
        compressMbS: mb / Math.max(compressCpu / 1e6, 1e-6),
        decompressMbS: mb / Math.max(decompressCpu / 1e6, 1e-6),
    };
}

const args = parseBenchArgs(process.argv.slice(2));
const data = await samples();
const metrics: BaselineMetrics = {};
renderCliHeader("Compression settings per kind of data", "one thread; saving = 1 - compressed / original");
const table = createBoxTable(["DATA", "MB", ...SETTINGS.map((setting) => setting.name)]);

for (const [kind, bytes] of Object.entries(data)) {
    if (bytes.length === 0) {
        continue;
    }

    const cells: string[] = [];

    for (const setting of SETTINGS) {
        const result = measure(bytes, setting);
        metrics[`${kind}.${setting.name}.savingPct`] = result.saving * 100;
        metrics[`${kind}.${setting.name}.compressMbS`] = result.compressMbS;
        metrics[`${kind}.${setting.name}.decompressMbS`] = result.decompressMbS;
        cells.push(
            `${(result.saving * 100).toFixed(1)}% ${result.compressMbS.toFixed(0)}/${result.decompressMbS.toFixed(0)}`
        );
    }

    table.push([kind, (bytes.length / 1e6).toFixed(0), ...cells]);
}

out.println(table.toString());
out.println("cells: saving, compress MB/s / decompress MB/s (CPU, one thread)");

await finishBench({
    name: "compress-presets",
    title: "zstd settings per kind of data (saving %, MB/s per CPU second)",
    args: { ...args, runs: 1 },
    runs: [metrics],
    lowerIsBetter: [],
    notes: `samples up to 64 MiB; ${Object.entries(data)
        .map(([kind, bytes]) => `${kind} ${(bytes.length / 1e6).toFixed(0)} MB`)
        .join(", ")}; repo at ${statSync(REPO).mtime.toISOString()}`,
    context: { settings: SETTINGS },
});
