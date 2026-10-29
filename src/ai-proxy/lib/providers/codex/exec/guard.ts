import { type HooksConfig, loadHooksConfig } from "@app/agents/lib/hooks/config";
import { guardRules } from "@app/agents/lib/hooks/custom-rules";
import { evaluateCommand } from "@app/agents/lib/hooks/guard";
import type { CommandGuard } from "@app/ai-proxy/lib/providers/codex/exec/types";
import { env } from "@genesiscz/utils/env";
import type { ShellRule } from "@genesiscz/utils/shell/rules/types";

const ALLOW_ALL: CommandGuard = { check: () => ({ outcome: "allow" }) };

/**
 * The shell guard of `tools agents hooks`, for the commands an `exec` script runs. Claude Code's PreToolUse hook sees
 * only the runner's own command, so each nested `cmd` goes through the same evaluator, config and custom rules here.
 * A block is a deny the script sees; a warn runs the command and rides along; context notes are left out, because
 * the hook caps them per session and the runner has no session counter.
 */
export async function shellGuard(
    options: { config?: HooksConfig; rules?: readonly ShellRule[] } = {}
): Promise<CommandGuard> {
    if (env.agents.areHooksDisabled()) {
        return ALLOW_ALL;
    }

    const config = options.config ?? loadHooksConfig();

    if (!config.guard.enabled || config.shadow) {
        return ALLOW_ALL;
    }

    const rules = options.rules ?? (await guardRules(config)).rules;

    return {
        check(cmd, cwd) {
            const verdict = evaluateCommand(cmd, config, { harness: "claude", cwd, rules });

            if (verdict.outcome === "block" || verdict.outcome === "warn") {
                return { outcome: verdict.outcome, message: verdict.message, rules: verdict.tags };
            }

            return { outcome: "allow" };
        },
    };
}
