#!/usr/bin/env bun
/**
 * One sample for `call-sites-bench.ts`: one call site, run twice in this fresh process (cold = the first call of a CLI
 * run, with the site's module already loaded; warm = a resident server), printed as one `@@sample` JSON line. CPU is
 * this process plus every child it waited for, so a site that spends its time in `ps` is not called free. `toolSpawns` counts the ps, lsof and pgrep processes of
 * the cold run (a floor: `Bun.$` and native spawns are invisible to the counter).
 *
 *   bun scripts/benchmarks/process/call-site-child.ts <site id>
 */
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { CALL_SITES, checkValue, isProcessToolSpawn, SAMPLE_MARKER } from "./call-sites";
import { cpuNowMs } from "./cpu";

const id = process.argv[2];
const site = CALL_SITES.find((candidate) => candidate.id === id);

if (!site) {
    throw new Error(
        `unknown call site '${id}'; list them with: bun scripts/benchmarks/process/call-sites-bench.ts --list`
    );
}

async function once(run: () => unknown) {
    const cpuBefore = cpuNowMs();
    const wallBefore = performance.now();
    const { result, spawns } = await withSpawnCounter(async () => run());

    return {
        cpuMs: cpuNowMs() - cpuBefore,
        wallMs: performance.now() - wallBefore,
        toolSpawns: spawns.filter((spawn) => isProcessToolSpawn(spawn.cmd)).length,
        spawns: spawns.length,
        check: checkValue(result),
    };
}

// The cold run starts with the site's module loaded, so it measures the first call. Loading the module costs the same
// before and after a migration, and a stand-in loads none, so counting it would charge a real function about 20 ms
// that the stand-in it replaced never paid.
if (!site.standIn) {
    await import(join(import.meta.dir, "../../..", site.file));
}

const cold = await once(site.run);
const warm = await once(site.run);

process.stdout.write(
    `${SAMPLE_MARKER}${SafeJSON.stringify(
        {
            coldCpuMs: cold.cpuMs,
            warmCpuMs: warm.cpuMs,
            coldWallMs: cold.wallMs,
            toolSpawns: cold.toolSpawns,
            spawns: cold.spawns,
            check: warm.check,
        },
        { strict: true }
    )}\n`
);
