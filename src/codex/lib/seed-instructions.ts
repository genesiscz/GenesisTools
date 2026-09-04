import { buildWorkerContract } from "@genesiscz/utils/worker/contract";

/**
 * The codex door onto the shared worker contract (`src/utils/worker/contract.ts`),
 * kept for its callers and tests: the swarm identity, the bus commands, the
 * checkpoint contract and the report shape are the same text every backend gets.
 */
export function buildAgentInstructions(options: {
    agentName: string;
    rendezvousSession: string;
    leadName: string;
    sandbox?: string;
}): string {
    return buildWorkerContract({
        backend: "codex",
        sandbox: options.sandbox === "read-only" ? "read-only" : "workspace-write",
        bus: { agentName: options.agentName, leadName: options.leadName, rendezvousSession: options.rendezvousSession },
    });
}
