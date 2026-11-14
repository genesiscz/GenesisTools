import { openProject } from "@app/recorder/lib/edit";
import { out } from "@genesiscz/utils/logger";
import { describeProject } from "@genesiscz/utils/recording-editor/project";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("project")
        .description("Print a recording's edit: its clips, zooms, audio and export settings (times in source seconds)")
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .action(async (value: string) => {
            try {
                const opened = await openProject(value);
                out.result({ ...describeProject(opened.project, opened.path), saved: !opened.fresh });
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
