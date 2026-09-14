import type { AgentToolSpec } from "@app/ai/commands/agent/spec";
import { createGrokAdapter } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { grokDriver } from "./driver";
import { grokLauncher } from "./launcher";
import { classifyGrokArgs } from "./process-scan";

/** What `tools grok` is. Every shared verb comes from this object and nothing else. */
export const grokSpec: AgentToolSpec = {
    alias: "grok",
    provider: "grok-sub",
    description: "Open the grok TUI as an account, resume sessions, drive isolated headless grok workers",
    adapter: () => createGrokAdapter(),
    launcher: grokLauncher,
    worker: grokDriver,
    processScan: { classify: classifyGrokArgs },
    help: {
        // xAI reports one monthly billing credit rather than percentage windows.
        usage: "Grok monthly billing credit (interactive TUI)",
        login: "Log in to SuperGrok in the browser and store the grant as a grok-sub account",
    },
};
