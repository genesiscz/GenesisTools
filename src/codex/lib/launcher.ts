import type { AgentLauncher } from "@app/ai/commands/agent/spec";
import { createCodexAdapter } from "@genesiscz/utils/agent-sessions/codex-sessions";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { nativeSessionRootsForHome } from "@genesiscz/utils/providers/session-paths";
import { validateTuiArgs } from "./launch-options";
import { realHome, runAccountTerminal, sharedCodexHome } from "./run-account-terminal";
import type { CodexRunOptions } from "./run-options";

/**
 * The Codex half of the shared `run`: an account-bound app-server plus the native TUI on
 * `--remote`. Everything the verb shares (the account picker, the resume selector, the
 * flag set) lives in `@app/ai/commands/agent`; this file holds only what is Codex-shaped.
 */
export const codexLauncher: AgentLauncher = {
    extendRun(command) {
        command
            .option("--home <path>", "Shared Codex home (default ~/.codex, independent of inherited CODEX_HOME)")
            .option(
                "--computer-use",
                "Require the official Mac Computer Use runtime (automatically enabled when installed)"
            )
            .option("--no-computer-use", "Skip native Computer Use configuration overrides");
    },

    /** Native argv is refused before anyone is asked to pick an account. */
    async preflight({ passthrough }) {
        validateTuiArgs(passthrough);
        return undefined;
    },

    /** The `--home` roots plus the plugin's own; that home's copies win over retained originals. */
    async resumeScope({ flags }) {
        const home = sharedCodexHome(typeof flags.home === "string" ? flags.home : undefined);
        registerBuiltInPlugins();
        const native = providerPlugin("openai-sub").codingAgent;
        const roots = [...new Set([...nativeSessionRootsForHome("codex", home), ...(native?.roots() ?? [])])];

        return { adapter: createCodexAdapter(roots), preferredHome: await realHome(home) };
    },

    async launch(input) {
        const flags = input.flags as CodexRunOptions;

        await runAccountTerminal({
            account: input.account,
            ...(input.session === undefined ? {} : { session: input.session }),
            args: input.passthrough,
            options: {
                ...flags,
                cwd: input.cwd,
                ...(input.model === undefined ? {} : { model: input.model }),
                ...(input.nativeResume ? { resume: true } : {}),
                continue: input.continueLast,
            },
        });
    },
};
