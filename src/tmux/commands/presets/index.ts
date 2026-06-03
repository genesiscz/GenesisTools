import { registerPresetDeleteCommand } from "@app/tmux/commands/presets/delete";
import { registerPresetListCommand } from "@app/tmux/commands/presets/list";
import { registerPresetRestoreCommand } from "@app/tmux/commands/presets/restore";
import { registerPresetSaveCommand } from "@app/tmux/commands/presets/save";
import type { Command } from "commander";

export function registerPresetsCommand(program: Command): void {
    const presets = program.command("presets").description("Save / restore named tmux session layouts");

    registerPresetSaveCommand(presets);
    registerPresetListCommand(presets);
    registerPresetRestoreCommand(presets);
    registerPresetDeleteCommand(presets);
}
