import { undoLastEdit } from "@app/recorder/lib/movie-client";
import { out } from "@genesiscz/utils/logger";
import { describeProject } from "@genesiscz/utils/recording-editor/project";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("undo")
        .description(
            "Put an edit back as it was before its last change, made with apply, the REPL or the editor window (30 steps, across runs); redo makes it again"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .action(async (value: string) => {
            try {
                const undone = await undoLastEdit(value);
                out.result({ undone: undone.undone ?? [], ...describeProject(undone.project, undone.path) });
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
