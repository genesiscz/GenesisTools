import { registerUsageDaemonCommands } from "@app/ai/commands/usage/daemon";
import type { Command } from "commander";

/**
 * `tools claude daemon` is now an alias for `tools ai usage daemon`: one task
 * (`ai-usage-poll`) polls every provider, and `register` removes the old
 * `claude-usage-poll` task on the way through. That single command is the whole user
 * migration (decision D11, spec 2026-09-04 sections 6.5 and 13.7).
 */
export function registerDaemonCommand(program: Command): void {
    registerUsageDaemonCommands(program);
}

export {
    LEGACY_USAGE_TASK_NAME,
    USAGE_TASK_NAME,
    validateRetentionDays,
    validateRetentionMin,
} from "@app/ai/commands/usage/daemon";
