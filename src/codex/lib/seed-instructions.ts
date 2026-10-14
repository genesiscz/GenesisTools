import { buildWorkerContract, type WorkerSandbox } from "@genesiscz/utils/worker/contract";

/** The contract's name for a codex sandbox mode: `danger-full-access` (`--write full`) has no sandbox at all. */
export function contractSandbox(sandbox: string | undefined): WorkerSandbox {
    if (sandbox === "read-only") {
        return "read-only";
    }

    return sandbox === "danger-full-access" ? "none" : "workspace-write";
}

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
        sandbox: contractSandbox(options.sandbox),
        bus: { agentName: options.agentName, leadName: options.leadName, rendezvousSession: options.rendezvousSession },
    });
}
