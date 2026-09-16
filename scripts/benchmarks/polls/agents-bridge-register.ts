#!/usr/bin/env bun
/**
 * Baseline for `CliAgentsTransport.register()` — `src/codex/lib/agents-bridge.ts:292`.
 *
 * The loop polls for an agent record by spawning `tools agents discover` every
 * 50 ms until the record appears or 5 s pass. Each iteration is a whole child
 * process: the `tools` launcher, a Bun start, a commander parse, and only then
 * the two lib calls (`readFeed` + `deriveRegistry`) the caller actually wants.
 *
 * WHAT IS REAL HERE. Everything. The default `CliAgentsTransport` is
 * constructed with no fakes and spawns the real `tools` binary for every poll;
 * `withSpawnCounter` counts those spawns by intercepting `Bun.spawn`.
 *
 * HOW THE FULL DEADLINE IS FORCED. `register()` also spawns
 * `tools agents login --once`, which would register the agent within a poll or
 * two and end the wait early. The benchmark points `GENESIS_TOOLS_HOME` at a
 * fresh temp root and pre-creates the session directory read-only (mode 0500)
 * with an empty `feed.jsonl`. The login process then cannot take the feed lock
 * and exits without registering, while `discover` still reads the empty feed and
 * answers `[]` — so the loop runs its whole 5 s deadline, which is the worst case
 * the in-process fix removes. The directory mode is restored in a `finally`.
 *
 * `spawnCount` and `discoverSpawns` are load-dependent rather than fixed: the
 * loop spawns as fast as `tools` can answer, so a busy machine produces fewer,
 * slower iterations. `medianDiscoverCycleMs` is the per-iteration cost that
 * explains the difference, and after the fix it should collapse to about the
 * 50 ms sleep with zero spawns.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BaselineMetrics, sampleSelf, withSpawnCounter } from "@app/benchmark/lib";
import { CliAgentsTransport } from "@app/codex/lib/agents-bridge";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { addCommonOptions, type CommonFlags, runPollBenchmark } from "./harness";

/** `register()` hard-codes its deadline; the sample window tracks it rather than setting it. */
const REGISTER_DEADLINE_MS = 5_000;

const AGENT_NAME = "bench-register";

interface SessionFixture {
    session: string;
    sessionDir: string;
}

/**
 * A temp `GENESIS_TOOLS_HOME` holding one session directory that no process can
 * write to. `agentsRoot()` reads that variable on every call, so both this
 * process and the `tools` children it spawns resolve to the fixture.
 */
function createReadOnlySession(): SessionFixture {
    const home = mkdtempSync(join(tmpdir(), "gt-bench-agents-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    const session = `bench-${Date.now()}`;
    const sessionDir = join(home, ".genesis-tools", "agents", session);
    mkdirSync(join(sessionDir, "slots"), { recursive: true });
    writeFileSync(join(sessionDir, "feed.jsonl"), "");
    chmodSync(join(sessionDir, "slots"), 0o500);
    chmodSync(sessionDir, 0o500);

    return { session, sessionDir };
}

function medianOf(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

async function measure(): Promise<BaselineMetrics> {
    const fixture = createReadOnlySession();
    const transport = new CliAgentsTransport();
    const startedAt = performance.now();

    try {
        const [counted, sample] = await Promise.all([
            withSpawnCounter(async () => {
                try {
                    return await transport.register(AGENT_NAME, fixture.session);
                } catch (err) {
                    // The timeout IS the measured path; anything else is a real failure.
                    const message = err instanceof Error ? err.message : String(err);

                    if (!message.includes("did not register")) {
                        throw err;
                    }

                    return null;
                }
            }),
            sampleSelf({ windowMs: REGISTER_DEADLINE_MS, countThreads: false }),
        ]);
        const elapsedMs = Math.round(performance.now() - startedAt);

        if (counted.result !== null) {
            throw new Error("register() found an agent record; the read-only session fixture is not holding");
        }

        const discovers = counted.spawns.filter((spawn) => spawn.cmd.includes("discover"));
        const cycles: number[] = [];

        for (let i = 1; i < discovers.length; i++) {
            cycles.push((discovers[i]?.at ?? 0) - (discovers[i - 1]?.at ?? 0));
        }

        return {
            spawnCount: counted.count,
            discoverSpawns: discovers.length,
            elapsedMs,
            cpuPercent: Number(sample.cpuPercent.toFixed(2)),
            medianDiscoverCycleMs: Number(medianOf(cycles).toFixed(2)),
        };
    } finally {
        chmodSync(fixture.sessionDir, 0o700);
        chmodSync(join(fixture.sessionDir, "slots"), 0o700);
    }
}

const program = addCommonOptions(
    new Command()
        .name("agents-bridge-register")
        .description("Measure the spawn-per-poll register() loop in src/codex/lib/agents-bridge.ts")
);
await program.parseAsync(process.argv);
const flags = program.opts<CommonFlags>();

out.log.info("Each run spawns real `tools agents discover` children for a full 5 s deadline.");

await runPollBenchmark({
    stem: "agents-bridge-register",
    title: "agents-bridge register() — one `tools agents discover` child process per poll",
    setup: "real CliAgentsTransport, temp GENESIS_TOOLS_HOME, read-only session dir so the 5 s deadline runs in full",
    flags,
    measure,
});
