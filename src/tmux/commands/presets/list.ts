import { out } from "@app/logger";
import { TmuxPresetStore } from "@app/utils/tmux/snapshot-store";
import type { Command } from "commander";
import pc from "picocolors";

interface ListPresetsFlags {
    json?: boolean;
}

export function registerPresetListCommand(parent: Command): void {
    parent
        .command("list")
        .description("List saved tmux session presets")
        .option("--json", "Output as JSON")
        .action((flags: ListPresetsFlags) => {
            runListPresets(flags);
        });
}

export function runListPresets(flags: ListPresetsFlags): void {
    const store = new TmuxPresetStore();
    const presets = store.list();

    if (flags.json) {
        out.result(presets);
        return;
    }

    if (presets.length === 0) {
        out.println(pc.dim(`(no presets — save one with "tools tmux presets save")`));
        out.println(pc.dim(`dir: ${store.getDir()}`));
        return;
    }

    for (const preset of presets) {
        const counts = `${preset.sessions} session(s) · ${preset.windows} window(s) · ${preset.panes} pane(s)`;
        out.println(`${pc.cyan(preset.name)} ${pc.dim(`(${preset.capturedAt})`)}`);
        out.println(`  ${pc.dim(counts)}`);

        if (preset.note) {
            out.println(`  ${pc.dim("note:")} ${preset.note}`);
        }

        out.println(`  ${pc.dim("file:")} ${preset.path}`);
    }
}
