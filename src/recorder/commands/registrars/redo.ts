import { redoLastEdit } from "@app/recorder/lib/movie-client";
import { out } from "@genesiscz/utils/logger";
import { describeProject } from "@genesiscz/utils/recording-editor/project";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("redo")
        .description("Make the last change that undo took back again, while the edit has not changed since that undo")
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .action(async (value: string) => {
            try {
                const redone = await redoLastEdit(value);
                out.result({ redone: redone.redone ?? [], ...describeProject(redone.project, redone.path) });
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
