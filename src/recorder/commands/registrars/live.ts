import {
    alreadyInState,
    describeLiveEntries,
    findLiveEntry,
    liveRecordingRef,
    markerLabelProblem,
} from "@app/recorder/lib/library";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { callRecorder, type LiveEntry, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import type { Command } from "commander";

const LIVE_ID_HELP = `a live recording id or its end (${toolCommand("recorder list --live")}), or the recording's library id as start and list print it`;

const JSON_ANSWER_HELP = "the answer is JSON either way; the flag is accepted for scripts";

/** The live recording a control command means: the one named, else the only one, else the newest. */
function liveId(id: string | undefined): string {
    return liveEntry(id).id;
}

function liveEntry(id: string | undefined): LiveEntry {
    const entries = listLiveRecordings();

    if (id) {
        const found = findLiveEntry(entries, id);

        if (!found) {
            throw new Error(`No live recording "${id}". Running: ${describeLiveEntries(entries) || "none"}`);
        }

        return found;
    }

    const newest = entries.at(-1);

    if (!newest) {
        throw new Error(`No recording is running. Start one with ${toolCommand("recorder start")}.`);
    }

    return newest;
}

export function register(program: Command): void {
    for (const method of ["stop", "pause", "resume", "status"] as const) {
        program
            .command(method)
            .description(
                method === "status"
                    ? "Print the live recording's state (the newest one, or the id given)"
                    : `${method[0].toUpperCase()}${method.slice(1)} the live recording (the newest one, or the id given)`
            )
            .argument("[id]", LIVE_ID_HELP)
            .option("--json", JSON_ANSWER_HELP)
            .action(async (id: string | undefined) => {
                try {
                    const entry = liveEntry(id);

                    if (method === "pause" || method === "resume") {
                        const status = await callRecorder({ id: entry.id, method: "status" });
                        const state =
                            status !== null && typeof status === "object" ? Reflect.get(status, "state") : undefined;
                        const already = alreadyInState(method, typeof state === "string" ? state : undefined);

                        if (already) {
                            out.printlnErr(already);
                            out.result({ already: true, state, ...liveRecordingRef(entry) });
                            return;
                        }
                    }

                    const answer = await callRecorder({
                        id: entry.id,
                        method,
                        params: method === "stop" ? { wait: true } : undefined,
                    });
                    // The live id controls it; the library id and folder are what every later command takes.
                    const reply = answer !== null && typeof answer === "object" ? answer : { answer };
                    out.result({ ...reply, ...liveRecordingRef(entry, { stopped: method === "stop" }) });
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            });
    }

    program
        .command("mark")
        .description("Mark this moment of the live recording with a label; the editor and movie.markers() show it")
        .argument("<label>", "what happened (1 to 80 characters)")
        .argument("[id]", LIVE_ID_HELP)
        .option("--json", JSON_ANSWER_HELP)
        .action(async (label: string, id: string | undefined) => {
            const problem = markerLabelProblem(label);

            if (problem) {
                out.printlnErr(problem);
                process.exitCode = 1;
                return;
            }

            try {
                out.result(await callRecorder({ id: liveId(id), method: "marker.add", params: { label } }));
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
