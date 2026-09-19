import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { circuitCache } from "./cache";
import { CIRCUIT_TIERS, type CircuitGraph } from "./circuit";
import { FlyArena } from "./engine";
import { decideArena } from "./policy";
import { ARENA_MODES, needsCircuit, needsJev } from "./types";

export const arenaSimulationSchema = z
    .object({
        mode: z.enum(ARENA_MODES).default("malecns"),
        tierId: z.enum(["compact", "balanced", "standard", "expanded"]).default("compact"),
        wiring: z.enum(["original", "shuffled", "disconnected"]).default("original"),
        seed: z.number().int().min(0).max(999999).default(42),
        seconds: z.number().min(0.02).max(60).default(10),
        decisionEvery: z.number().min(1).max(10).default(2),
    })
    .strict();

export async function simulateArena({
    input,
    signal,
    provider,
    load = (tierId, signal) => circuitCache.load({ tierId, signal }),
    decide = decideArena,
}: {
    input: unknown;
    signal?: AbortSignal;
    provider?: EvaluationProviderId;
    load?: (tierId: string, signal?: AbortSignal) => Promise<{ graph: CircuitGraph }>;
    decide?: typeof decideArena;
}) {
    const options = arenaSimulationSchema.parse(input);
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    combined.throwIfAborted();
    const loaded = needsCircuit(options.mode) ? await load(options.tierId, combined) : null;
    const arena = new FlyArena({ ...options, graph: loaded?.graph });
    const decisions: Array<{ elapsed: number; decision: Awaited<ReturnType<typeof decideArena>> }> = [];
    const failures: Array<{ elapsed: number; message: string }> = [];
    let attempts = 0;
    let lastDecision = -100;
    let steps = 0;
    arena.start();
    while (arena.state.status === "running" && arena.state.elapsed < options.seconds) {
        combined.throwIfAborted();
        if (needsJev(options.mode) && arena.state.elapsed - lastDecision >= options.decisionEvery && attempts < 30) {
            lastDecision = arena.state.elapsed;
            attempts++;
            try {
                const decision = await decide({ observation: arena.observe(), signal: combined, provider });
                arena.setDecision(decision);
                decisions.push({ elapsed: arena.state.elapsed, decision });
            } catch (error) {
                combined.throwIfAborted();
                arena.clearDecision();
                logger.warn({ error }, "Jev arena decision failed; using local fallback");
                failures.push({
                    elapsed: arena.state.elapsed,
                    message: error instanceof Error ? error.message : "Decision failed",
                });
            }
        }
        arena.advance({ milliseconds: 20 });
        if (++steps % 100 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }
    arena.pause();
    return {
        options,
        circuit: loaded ? CIRCUIT_TIERS.find((tier) => tier.id === options.tierId) : null,
        state: arena.state,
        decisions,
        failures,
        attempts,
    };
}
