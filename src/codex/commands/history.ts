import { createCodexAdapter } from "@genesiscz/utils/agent-sessions/codex-sessions";
import { registerAgentHistoryCommand } from "@genesiscz/utils/agent-sessions/history-cli";
import type { Command } from "commander";

export function registerCodexHistoryCommand(program: Command): void {
    registerAgentHistoryCommand(program, createCodexAdapter(), "codex");
}
