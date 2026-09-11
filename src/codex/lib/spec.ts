import type { AgentToolSpec } from "@app/ai/commands/agent/spec";
import { registerRunCommand } from "@app/codex/commands/run";
import { createCodexAdapter } from "@genesiscz/utils/agent-sessions/codex-sessions";
import { codexDriver } from "./driver";
import { codexLauncher } from "./launcher";
import { CODEX_HELPER_KINDS, classifyCodexArgs } from "./process-scan";

/** What `tools codex` is. Codex's own extra verbs register beside this, never inside it. */
export const codexSpec: AgentToolSpec = {
    alias: "codex",
    provider: "openai-sub",
    description: "Spawn, monitor, and steer Codex app-server sessions",
    adapter: () => createCodexAdapter(),
    launcher: codexLauncher,
    worker: codexDriver,
    processScan: { classify: classifyCodexArgs, helperKinds: CODEX_HELPER_KINDS },
    help: {
        // Codex has no presenter, so the Overview draws the two windows the app-server reports.
        usage: "Codex rate-limit windows (interactive TUI)",
    },
    overrides: {
        // `run <account> [native args...]` needs commander's positional-option mode, and that
        // switch is global: turning it on unconditionally makes `-v` unrecognised after every
        // other subcommand. The wrapper scopes it to the one invocation that needs it.
        run: (program) => {
            registerRunCommand(program);
        },
    },
};
