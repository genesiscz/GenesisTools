import { registerControlCommands } from "@app/control/commands";
import type { Command } from "commander";

export function registerControlLabCommands(program: Command): void {
    const control = program.command("control").description("All macOS control commands using this Jev checkout");
    registerControlCommands(control);
}
