import type { Command } from "commander";
import { registerDeleteCommand } from "@app/cmux/commands/profiles/delete";
import { registerEditCommand } from "@app/cmux/commands/profiles/edit";
import { registerListCommand } from "@app/cmux/commands/profiles/list";
import { registerPathCommand } from "@app/cmux/commands/profiles/path";
import { registerRestoreCommand } from "@app/cmux/commands/profiles/restore";
import { registerSaveCommand } from "@app/cmux/commands/profiles/save";
import { registerViewCommand } from "@app/cmux/commands/profiles/view";

export function registerProfilesCommand(program: Command): void {
    const profiles = program
        .command("profiles")
        .description("Manage saved cmux workspace profiles");

    registerSaveCommand(profiles);
    registerListCommand(profiles);
    registerViewCommand(profiles);
    registerRestoreCommand(profiles);
    registerEditCommand(profiles);
    registerDeleteCommand(profiles);
    registerPathCommand(profiles);
}
