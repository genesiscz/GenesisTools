import { registerAccountLoginCommand } from "@app/ai/commands/accounts/login";
import type { Command } from "commander";

export function registerCodexLoginCommand(program: Command): void {
    registerAccountLoginCommand(program, {
        provider: "openai-sub",
        tool: "tools codex login",
        subcommand: ["login"],
    });
}
