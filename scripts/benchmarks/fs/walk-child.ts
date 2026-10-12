#!/usr/bin/env bun
/**
 * One sample for `walk-primitives.ts`: walks one session tree with one walker, twice in this fresh process
 * (cold: what a CLI process pays; warm: what a resident process pays the next time), and prints
 * `{ coldCpuMs, warmCpuMs, files }` as JSON. Every walker returns each matching file WITH its mtime, because
 * that is what "changed in the last N hours" needs. The C arms load `fastwalk.c` through `defineNativeLibrary`:
 * `clang` opens its cached build, and the `tcc` cold pass includes TinyCC compiling it.
 *
 *   bun scripts/benchmarks/fs/walk-child.ts <arm> <tree>
 */
import { ptr, toArrayBuffer } from "bun:ffi";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { walkSourceRoots } from "@genesiscz/utils/agent-sessions/source-discovery";
import { defineNativeLibrary } from "@genesiscz/utils/bun/compiler";
import { fastWalk } from "@genesiscz/utils/fs/fast-walk";
import { SafeJSON } from "@genesiscz/utils/json";
import { WALK_ARMS, WALK_TREES, type WalkTreeName } from "./walk-trees";

const [arm, treeName] = process.argv.slice(2);
const tree = WALK_TREES[treeName as WalkTreeName];

if (!tree || !(WALK_ARMS as readonly string[]).includes(arm)) {
    throw new Error(`usage: walk-child.ts <${WALK_ARMS.join("|")}> <${Object.keys(WALK_TREES).join("|")}>`);
}

const wanted = (name: string) =>
    tree.names.some((pattern) => (pattern.startsWith("*") ? name.endsWith(pattern.slice(1)) : name === pattern));

const cWalker = defineNativeLibrary({
    source: join(import.meta.dir, "fastwalk.c"),
    compiler: arm === "tcc" ? "tcc" : "clang",
    symbols: {
        fw_walk: { args: ["ptr", "i32", "ptr", "i32", "ptr"], returns: "ptr" },
        fw_free: { args: ["ptr"], returns: "void" },
    },
});

/** Files the C walker found: it answers one line per entry, `f\t…` for a file. */
function walkInC(): number {
    const { symbols } = cWalker();
    const length = new BigUint64Array(1);
    const result = symbols.fw_walk(
        Buffer.from(`${tree.roots.join("\n")}\0`),
        tree.maxDepth ?? -1,
        Buffer.from(`${tree.names.join("\n")}\0`),
        0,
        ptr(length)
    );

    if (!result) {
        throw new Error("the C walker returned no buffer");
    }

    const text = new TextDecoder().decode(toArrayBuffer(result, 0, Number(length[0])));
    symbols.fw_free(result);
    return text.split("\n").filter((line) => line.startsWith("f\t")).length;
}

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

    if (arm === "clang" || arm === "tcc") {
        return walkInC();
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
