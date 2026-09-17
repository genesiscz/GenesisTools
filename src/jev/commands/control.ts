import { registerAssistCommand } from "@app/control/commands/assist";
import { registerDecisionCommands } from "@app/control/commands/decision";
import { registerFillCommand } from "@app/control/commands/fill";
import { registerReplayCommand } from "@app/control/commands/replay";
import type { Command } from "commander";

export function registerControlLabCommands(program: Command): void {
    const control = program
        .command("control")
        .description("Resolve, judge, replay, fill and assist through the Jev control core");
    registerDecisionCommands(control);
    registerReplayCommand(control);
    registerFillCommand(control);
    registerAssistCommand(control);
}
