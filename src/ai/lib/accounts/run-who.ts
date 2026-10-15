import { CLAUDE_WHO_SOURCE } from "@app/claude/lib/active-sessions";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { runAgentWho } from "../agent-who";

/** `tools ai accounts who`: Claude's `who`, the same table `tools claude who` prints. */
export interface RunWhoOptions {
    json?: boolean;
    all?: boolean;
}

export async function runWho(opts: RunWhoOptions): Promise<void> {
    await runAgentWho({ ...CLAUDE_WHO_SOURCE, tool: toolCommand("claude"), noAccountLabel: "keychain?" }, opts);
}
