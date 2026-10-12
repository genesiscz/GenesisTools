#!/usr/bin/env bun
/**
 * One sample for `walk-primitives.ts`: walks one session tree with one walker, twice in this fresh process
 * (cold: what a CLI process pays; warm: what a resident process pays the next time), and prints
 * `{ coldCpuMs, warmCpuMs, files }` as JSON. Every walker returns each matching file WITH its mtime, because
 * that is what "changed in the last N hours" needs.
 *
 *   bun scripts/benchmarks/fs/walk-child.ts <native|js|walkSourceRoots> <tree>
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { walkSourceRoots } from "@genesiscz/utils/agent-sessions/source-discovery";
import { fastWalk } from "@genesiscz/utils/fs/fast-walk";
import { SafeJSON } from "@genesiscz/utils/json";
import { WALK_TREES, type WalkTreeName } from "./walk-trees";

const [arm, treeName] = process.argv.slice(2);
const tree = WALK_TREES[treeName as WalkTreeName];

if (!tree || !["native", "js", "walkSourceRoots"].includes(arm)) {
    throw new Error(`usage: walk-child.ts <native|js|walkSourceRoots> <${Object.keys(WALK_TREES).join("|")}>`);
}

const wanted = (name: string) =>
    tree.names.some((pattern) => (pattern.startsWith("*") ? name.endsWith(pattern.slice(1)) : name === pattern));

async function once(): Promise<number> {
    if (arm === "walkSourceRoots") {
        const walked = await walkSourceRoots({
            roots: tree.roots,
            filtered: tree.maxDepth !== undefined,
            ...(tree.maxDepth === undefined ? {} : { maxDepth: tree.maxDepth }),
            includeFile: ({ path }) => wanted(basename(path)),
        });
        const stats = await Promise.all(walked.files.map((file) => stat(file.path)));
        return stats.length;
    }

    const result = await fastWalk({
        roots: tree.roots,
        names: tree.names,
        engine: arm === "native" ? "native" : "js",
        ...(tree.maxDepth === undefined ? {} : { maxDepth: tree.maxDepth }),
    });
    return result.entries.filter((entry) => entry.kind === "file").length;
}

function cpuSince(started: NodeJS.CpuUsage): number {
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
}

const coldStarted = process.cpuUsage();
const files = await once();
const coldCpuMs = cpuSince(coldStarted);
const warmStarted = process.cpuUsage();
await once();
const warmCpuMs = cpuSince(warmStarted);

process.stdout.write(`${SafeJSON.stringify({ coldCpuMs, warmCpuMs, files }, { strict: true })}\n`);
