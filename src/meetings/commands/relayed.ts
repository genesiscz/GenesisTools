import {
    type AgentInstructions,
    agentInstructionsResult,
    outputAgentInstructions,
} from "@genesiscz/utils/ai/agent-instructions";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { shellWord } from "@genesiscz/utils/shell/quote";
import { confirmRelayed, type RelayedResult, relayedGroups } from "../lib/relayed";
import { withMeetingsClient } from "../lib/service/client";
import { TOOL } from "../lib/shared";

/** The command that asks the user about these items, and runs again to record the user's answer. */
export function confirmRelayedCommand(meeting: string, items: readonly string[]): string {
    return `${TOOL} listen ${shellWord(meeting)} --confirm-relayed ${items.map(shellWord).join(" ")}`;
}

/**
 * Posts (or reads the answer to) the user's confirmation of relayed answers: `confirmRelayed` over the client.
 * `askAgain`: the user asked for the window again after answering Not now (`--ask-again`).
 */
export async function runConfirmRelayed(options: {
    store: MeetingStore;
    meeting: string;
    items: readonly string[];
    askAgain?: boolean;
}): Promise<RelayedResult> {
    const groups = relayedGroups(options.meeting, options.items);
    const rerun = confirmRelayedCommand(options.meeting, options.items);
    return withMeetingsClient((client) =>
        confirmRelayed({
            groups,
            store: options.store,
            client,
            rerun,
            rerunAskingAgain: `${rerun} --ask-again`,
            askAgain: options.askAgain === true,
        })
    );
}

/**
 * Prints a relayed confirmation: each adopted decision with its Undo, the rows the user left out, and the FOR AGENTS
 * block when there is one (a stop exits 1). `lead` goes before the block (what the agent's own command already
 * saved). `--json` prints the result with `agentInstructions`.
 */
export function printRelayed(result: RelayedResult, options: { json?: boolean; lead?: string } = {}): void {
    const { instructions: given, ...rest } = result;
    const instructions: AgentInstructions | undefined =
        given && options.lead ? { ...given, text: `${options.lead}\n${given.text}` } : given;

    if (instructions?.stop) {
        process.exitCode = 1;
    }

    if (options.json) {
        out.result(
            SafeJSON.stringify({ ...rest, ...(instructions ? agentInstructionsResult(instructions) : {}) }, null, 2)
        );
        return;
    }

    for (const adopted of result.adopted) {
        ui.ok(
            `${adopted.meeting} ${adopted.items.join(" ")}: the user's own decision now (undo: ${TOOL} reopen ${adopted.meeting} --token ${adopted.token})`
        );
    }

    if (instructions) {
        outputAgentInstructions(instructions);
    }
}
