import type { AgentToolSpec } from "@app/ai/commands/agent/spec";
import { createGrokAdapter } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { grokLauncher } from "./launcher";

/** What `tools grok` is, for the shared coding-agent verbs. */
export const grokSpec: AgentToolSpec = {
    alias: "grok",
    provider: "grok-sub",
    description: "Open the grok TUI as an account, resume sessions, drive isolated headless grok workers",
    adapter: () => createGrokAdapter(),
    launcher: grokLauncher,
};
