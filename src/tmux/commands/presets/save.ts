import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { captureTmuxSnapshot, SNAPSHOT_VERSION, type TmuxPreset } from "@app/utils/tmux/snapshot";
import { PresetExistsError, TmuxPresetStore } from "@app/utils/tmux/snapshot-store";
import type { Command } from "commander";
import pc from "picocolors";

interface SaveFlags {
    prefix?: string;
    force?: boolean;
    skipHistory?: boolean;
    note?: string;
}

export function registerPresetSaveCommand(parent: Command): void {
    parent
        .command("save [name]")
        .description("Snapshot the current tmux sessions into a named preset")
        .option("--prefix <str>", "Only capture sessions whose name starts with this prefix")
        .option("-f, --force", "Overwrite an existing preset of the same name")
        .option("--skip-history", "Skip per-pane last-shell-command parsing (smaller / faster)")
        .option("--note <text>", "Free-form note stored on the preset")
        .action((name: string | undefined, flags: SaveFlags) => {
            runSavePreset(name, flags);
        });
}

export function runSavePreset(rawName: string | undefined, flags: SaveFlags): void {
    const name = (rawName?.trim() || defaultPresetName()).trim();
    const store = new TmuxPresetStore();

    if (store.exists(name) && !flags.force) {
        out.error(`Preset "${name}" already exists. Use --force to overwrite.`);

        if (!isInteractive()) {
            out.error(suggestCommand(`tools tmux presets save ${name}`, { add: ["--force"] }));
        }

        process.exitCode = 1;
        return;
    }

    const sessions = captureTmuxSnapshot({
        prefix: flags.prefix,
        skipHistory: flags.skipHistory,
    });

    if (sessions.length === 0) {
        out.error(
            flags.prefix
                ? `No tmux sessions match prefix "${flags.prefix}"`
                : "No tmux sessions to capture (is tmux running?)"
        );
        process.exitCode = 1;
        return;
    }

    const preset: TmuxPreset = {
        version: SNAPSHOT_VERSION,
        name,
        capturedAt: new Date().toISOString(),
        note: flags.note?.trim() || undefined,
        sessions,
    };

    try {
        const path = store.write(name, preset, { force: !!flags.force });
        const summary = store.summarize(preset);
        const totalPanes = summary.panes;
        const totalWindows = summary.windows;

        out.println(pc.green(`✓ saved preset ${pc.cyan(name)}`));
        out.println(
            `  ${pc.dim("sessions:")} ${summary.sessions}  ${pc.dim("windows:")} ${totalWindows}  ${pc.dim("panes:")} ${totalPanes}`
        );
        out.println(`  ${pc.dim("file:")} ${path}`);

        if (flags.prefix) {
            out.println(`  ${pc.dim("prefix:")} ${flags.prefix}`);
        }

        if (preset.note) {
            out.println(`  ${pc.dim("note:")} ${preset.note}`);
        }

        out.println(`\nRestore with ${pc.cyan(`tools tmux presets restore ${name}`)}`);
    } catch (error) {
        if (error instanceof PresetExistsError) {
            out.error(error.message);
            process.exitCode = 1;
            return;
        }

        logger.error({ error, name }, "[tmux presets save] failed");
        throw error;
    }
}

function defaultPresetName(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    return `snap-${yyyy}${mm}${dd}-${hh}${min}`;
}
