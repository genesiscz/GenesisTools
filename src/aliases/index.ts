#!/usr/bin/env bun

import { registerAnalyzeCommand } from "@app/aliases/commands/analyze";
import { registerApplyCommand } from "@app/aliases/commands/apply";
import { registerDecayCommand } from "@app/aliases/commands/decay";
import { registerResetCommand } from "@app/aliases/commands/reset";
import { registerStatusCommand } from "@app/aliases/commands/status";
import { out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import pc from "picocolors";

const program = new Command();

program
    .name("aliases")
    .description(
        "Mine shell history for hot command chains and single commands you reuse, and propose aliases for them."
    );

registerAnalyzeCommand(program);
registerApplyCommand(program);
registerDecayCommand(program);
registerStatusCommand(program);
registerResetCommand(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "aliases" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.error(pc.red(message));
        process.exit(1);
    }
}

main();
