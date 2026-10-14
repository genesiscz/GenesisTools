import { registerAgentWhoCommand } from "@app/ai/commands/agent/who";
import { CLAUDE_WHO_SOURCE } from "@app/claude/lib/active-sessions";
import type { Command } from "commander";

/** Claude's door onto the shared `who` (`tools ai accounts who` shows the same table). */
export function registerWhoCommand(program: Command): void {
    registerAgentWhoCommand(program, { ...CLAUDE_WHO_SOURCE, tool: "tools claude", noAccountLabel: "keychain?" });
}
