import {
    applyDisplayOps,
    DISPLAY_OP_NAMES,
    displayFramesFolder,
    displayOpSchema,
    isDisplayOp,
} from "@app/recorder/lib/display-ops";
import { openProject } from "@app/recorder/lib/edit";
import { applyEdit } from "@app/recorder/lib/movie-client";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { describeProject, EDIT_OP_NAMES, parseEditOps } from "@genesiscz/utils/recording-editor/project";
import type { Command } from "commander";

const { log } = logger.scoped("recorder");

export function register(program: Command): void {
    program
        .command("apply")
        .description(
            `Change a recording's edit with JSON ops, in order, saved once (the open editor window reloads it), e.g. {"op":"cut","from":4,"to":"0:09"}. Ops: ${EDIT_OP_NAMES.join(", ")}; for a frames recording of several displays also ${DISPLAY_OP_NAMES.join(", ")} (they remake its movie first, as one undo step; ${toolCommand("recorder displays")} lists its segments); a wrong or missing field names the right ones, and the REPL's help("movies") documents each. Times are source seconds or "mm:ss"`
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .argument("<ops>", "one op or an array of ops as JSON, or - to read them from stdin")
        .action(async (value: string, text: string) => {
            try {
                const raw = text === "-" ? await Bun.stdin.text() : text;
                let parsed: unknown;
                try {
                    parsed = SafeJSON.parse(raw, { strict: true });
                } catch (error) {
                    // A bare "JSON Parse error: Unexpected identifier" did not say which argument was wrong.
                    const why = error instanceof Error ? error.message : String(error);
                    throw new Error(
                        `the ops are not JSON (${why}); give one op or an array of them, e.g. '{"op":"cut","from":4,"to":"0:09"}'`
                    );
                }

                // Display ops change the recording's movie (its display plan), not the edit: they run first, then the
                // edit ops of the same call on the edit as the new movie left it.
                const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
                const displayOps = list.filter(isDisplayOp).map((op) => displayOpSchema.parse(op));
                const rest = list.filter((op) => !isDisplayOp(op));
                const displays =
                    displayOps.length > 0
                        ? (await applyDisplayOps(await displayFramesFolder(value, "change"), displayOps)).displays
                        : undefined;

                if (rest.length === 0) {
                    const opened = await openProject(value);
                    out.result({ ...describeProject(opened.project, opened.path), displays });
                    return;
                }

                const ops = parseEditOps(rest);
                const edited = await applyEdit(value, ops);
                // A normalize op also answers the loudness it measured, which the editor shows beside its button.
                out.result({
                    ...describeProject(edited.project, edited.path),
                    ...(edited.loudness ? { loudness: edited.loudness } : {}),
                    ...(edited.warnings ? { warnings: edited.warnings } : {}),
                    ...(displays ? { displays } : {}),
                });
            } catch (error) {
                log.debug({ error }, "recorder apply failed");
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
