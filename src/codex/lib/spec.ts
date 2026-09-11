import type { AgentToolSpec } from "@app/ai/commands/agent/spec";
import { createCodexAdapter } from "@genesiscz/utils/agent-sessions/codex-sessions";
import { codexLauncher } from "./launcher";

/** What `tools codex` is, for the shared coding-agent verbs. Codex extras register beside it. */
export const codexSpec: AgentToolSpec = {
    alias: "codex",
    provider: "openai-sub",
    description: "Spawn, monitor, and steer Codex app-server sessions",
    adapter: () => createCodexAdapter(),
    launcher: codexLauncher,
};
