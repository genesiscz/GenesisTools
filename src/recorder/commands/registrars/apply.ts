import { applyEdit } from "@app/recorder/lib/movie-client";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { describeProject, EDIT_OP_NAMES, parseEditOps } from "@genesiscz/utils/recording-editor/project";
import type { Command } from "commander";

const { log } = logger.scoped("recorder");

export function register(program: Command): void {
    program
        .command("apply")
        .description(
            `Change a recording's edit with JSON ops, in order, saved once (the open editor window reloads it), e.g. {"op":"cut","from":4,"to":"0:09"}. Ops: ${EDIT_OP_NAMES.join(", ")}; a wrong or missing field names the right ones, and the REPL's help("movies") documents each. Times are source seconds or "mm:ss"`
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

                const ops = parseEditOps(parsed);
                const edited = await applyEdit(value, ops);
                // A normalize op also answers the loudness it measured, which the editor shows beside its button.
                out.result({
                    ...describeProject(edited.project, edited.path),
                    ...(edited.loudness ? { loudness: edited.loudness } : {}),
                    ...(edited.warnings ? { warnings: edited.warnings } : {}),
                });
            } catch (error) {
                log.debug({ error }, "recorder apply failed");
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
