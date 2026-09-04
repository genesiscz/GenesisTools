import { createGrokAdapter } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { registerAgentHistoryCommand } from "@genesiscz/utils/agent-sessions/history-cli";
import type { Command } from "commander";

export function registerGrokHistoryCommand(program: Command): void {
    registerAgentHistoryCommand(program, createGrokAdapter(), "grok");
}
