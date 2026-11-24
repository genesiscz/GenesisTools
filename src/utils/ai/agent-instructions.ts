import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";

/**
 * How serious an instruction is: `info` tells the agent what to do next, `warning` names something it must not
 * ignore, `error` says the command refused or failed.
 */
export type AgentInstructionSeverity = "info" | "warning" | "error";

/**
 * What an agent does now, as every command and library gives it to an agent (docs/adr/0049-agent-instructions.md):
 * plain sentences, how serious they are, and whether the agent stops and asks the user before it goes on.
 */
export interface AgentInstructions {
    text: string;
    severity: AgentInstructionSeverity;
    /** The agent stops, asks the user, and goes on only after the user confirms. */
    stop: boolean;
}

/** The last line of a stop. It stands alone, so an agent that keeps only `| tail -1` of the output still reads it. */
export const AGENT_STOP_LINE = "Ask the user, and proceed only after the user confirms.";

/** The first line of the block: it says the lines under it are for an agent, and whether the agent stops. */
export function agentInstructionsHeader(instructions: Pick<AgentInstructions, "severity" | "stop">): string {
    return instructions.stop
        ? `==== FOR AGENTS: STOP (${instructions.severity}) ====`
        : `==== FOR AGENTS (${instructions.severity}) ====`;
}

/** The text under the header: the caller's sentences, and for a stop the line that says to ask the user. */
function agentInstructionsBody(instructions: AgentInstructions): string {
    const text = instructions.text.trim();
    return instructions.stop ? `${text}\n${AGENT_STOP_LINE}` : text;
}

/** The block a person or an agent reads: the header, then the body. */
export function formatAgentInstructions(instructions: AgentInstructions): string {
    return `${agentInstructionsHeader(instructions)}\n${agentInstructionsBody(instructions)}`;
}

export interface AgentInstructionsResult {
    agentInstructions: AgentInstructions;
}

/** The machine-readable form a `--json` run prints: the block's severity, stop and body. */
export function agentInstructionsResult(instructions: AgentInstructions): AgentInstructionsResult {
    return {
        agentInstructions: {
            severity: instructions.severity,
            stop: instructions.stop,
            text: agentInstructionsBody(instructions),
        },
    };
}

/**
 * Prints an instruction for an agent on stdout, the command's result channel: the block, or under `json` the
 * `{ agentInstructions }` object. The day log keeps it too. It sets no exit code: a command that stops sets its own.
 */
export function outputAgentInstructions(instructions: AgentInstructions, options: { json?: boolean } = {}): void {
    logger.debug(
        { severity: instructions.severity, stop: instructions.stop, text: instructions.text },
        "instructions for an agent"
    );

    if (options.json) {
        out.result(SafeJSON.stringify(agentInstructionsResult(instructions)));
        return;
    }

    out.println(formatAgentInstructions(instructions));
}

/**
 * An instruction a library throws instead of printing it (a refusal inside a service, a REPL call). Its message is
 * the same block, so it reads the same through RPC, a CLI's error line and a REPL error.
 */
export class AgentInstructionsError extends Error {
    readonly instructions: AgentInstructions;

    constructor(instructions: AgentInstructions) {
        super(formatAgentInstructions(instructions));
        this.name = "AgentInstructionsError";
        this.instructions = instructions;
    }
}
