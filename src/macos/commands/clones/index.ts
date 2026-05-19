import { createConfigCommand } from "@app/macos/commands/clones/config";
import { createDaemonCommand } from "@app/macos/commands/clones/daemon";
import { createDuplicatesCommand } from "@app/macos/commands/clones/duplicates";
import { createDuCommand, createMeasureCommand } from "@app/macos/commands/clones/measure";
import { createOptimizeCommand } from "@app/macos/commands/clones/optimize";
import { Command } from "commander";

function buildGroup(name: string): Command {
    const group = new Command(name).description(
        "Clone-aware disk usage: real reclaimable size, duplicates, safe dedupe (macOS/APFS)"
    );
    group.addCommand(createMeasureCommand());
    group.addCommand(createDuCommand());
    group.addCommand(createDuplicatesCommand());
    group.addCommand(createOptimizeCommand());
    group.addCommand(createConfigCommand());
    group.addCommand(createDaemonCommand());
    return group;
}

export function registerClonesCommand(program: Command): void {
    program.addCommand(buildGroup("clones"));
    program.addCommand(buildGroup("apfs"), { hidden: true });
}
