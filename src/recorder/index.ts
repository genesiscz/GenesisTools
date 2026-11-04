import { defaultRecordingTarget, listRecordingTargets, type RecordingTarget } from "@app/control/lib/recording-targets";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { describeProject, parseEditOps } from "@genesiscz/utils/recording-editor/project";
import { callRecorder, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { Command } from "commander";

import { editProject, openProject } from "./lib/edit";
import { ensureRecorderPart, exportEdit, listLibrary, movieOf, openEditor, resolveRecording } from "./lib/library";
import { makeProxy } from "./lib/proxy";
import { recordVideo, VIDEO_RECORDING_MAX_SECONDS } from "./lib/video-recording";

const { log } = logger.scoped("recorder");
const AUDIO_SOURCES = ["system", "mic"] as const;
type AudioSource = (typeof AUDIO_SOURCES)[number];

interface StartFlags {
    audio?: string;
    micDevice?: string;
    fps?: string;
    display?: string;
    window?: string;
    app?: string;
    title?: string;
    maxSeconds?: string;
    indicator?: boolean;
    controls?: boolean;
    open?: boolean;
    json?: boolean;
}

function parseAudio(raw: string | undefined): AudioSource[] | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const sources = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const unknown = sources.filter((value) => !AUDIO_SOURCES.includes(value as AudioSource));

    if (unknown.length > 0) {
        throw new Error(suggestEnumFlag("tools recorder start", "--audio", [...AUDIO_SOURCES]));
    }

    return sources as AudioSource[];
}

function bounded(raw: string | undefined, name: string, min: number, max: number): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw);

    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} takes a number from ${min} to ${max} (got "${raw}")`);
    }

    return value;
}

async function targetOf(flags: StartFlags): Promise<RecordingTarget> {
    if (flags.window) {
        return { kind: "window", windowIds: flags.window.split(",").map(Number) };
    }

    if (flags.app) {
        return { kind: "app", app: flags.app };
    }

    if (flags.display !== undefined) {
        return { kind: "display", screenIndex: bounded(flags.display, "--display", 0, 16) ?? 0 };
    }

    const targets = await listRecordingTargets();
    const main = targets.displays.find((display) => display.isPrimary) ?? targets.displays[0];
    return main
        ? { kind: "display", screenIndex: main.index }
        : (defaultRecordingTarget(targets, new Set()) ?? { kind: "display", screenIndex: 0 });
}

/** The live recording a control command means: the one named, else the only one, else the newest. */
function liveId(id: string | undefined): string {
    const entries = listLiveRecordings();

    if (id) {
        const found = entries.find((entry) => entry.id === id || entry.id.endsWith(id));

        if (!found) {
            throw new Error(
                `No live recording "${id}". Running: ${entries.map((entry) => entry.id).join(", ") || "none"}`
            );
        }

        return found.id;
    }

    const newest = entries.at(-1);

    if (!newest) {
        throw new Error("No recording is running. Start one with `tools recorder start`.");
    }

    return newest.id;
}

const program = new Command()
    .name("recorder")
    .description(
        "Screen recordings with a movie editor: record the screen, a window or an app with audio and the cursor, then cut, zoom and export in the recorder window or from the command line"
    );

program
    .command("start")
    .description(
        "Record a movie into the recordings library (screen.mp4 with audio tracks, cursor.jsonl, recording.json). Runs until `tools recorder stop`, the menu bar item, the floating controls, Ctrl-C or --max-seconds; pausing leaves the paused time out of the movie"
    )
    .option("--audio <sources>", "audio tracks: system, mic, or system,mic")
    .option("--mic-device <uid>", "the microphone (an id from `ax-tool audio-devices`; needs --audio mic)")
    .option("--fps <n>", "frames per second while something moves, 1–120", "60")
    .option("--display <index>", "record this display (NSScreen order; default the main display)")
    .option("--window <ids>", "record these windows (CG window ids, comma separated)")
    .option("--app <name>", "record this app's windows (name, bundle id or pid)")
    .option("--title <text>", "the recording's title in the library and the menu")
    .option("--max-seconds <n>", `stop after this long, 1–${VIDEO_RECORDING_MAX_SECONDS}`)
    .option("--no-indicator", "no red border around what is recorded (never in the movie either way)")
    .option("--no-controls", "do not open the floating controls")
    .option("--open", "open the editor when the recording stops")
    .option("--json", "events and the result as JSON lines on stdout")
    .action(async (flags: StartFlags) => {
        try {
            const target = await targetOf(flags);
            const result = await recordVideo({
                target,
                title: flags.title,
                fps: bounded(flags.fps, "--fps", 1, 120),
                audio: parseAudio(flags.audio),
                micDevice: flags.micDevice,
                maxSeconds: bounded(flags.maxSeconds, "--max-seconds", 1, VIDEO_RECORDING_MAX_SECONDS),
                indicator: flags.indicator,
                panel: flags.controls !== false,
                emit: (event) => {
                    if (flags.json) {
                        out.print(`${SafeJSON.stringify(event)}\n`);
                    } else if (event.event === "state") {
                        out.printlnErr(`${event.state} (${event.reason}) · ${Math.round(event.elapsedMs / 1000)} s`);
                    } else if (event.event === "error") {
                        out.printlnErr(`error: ${event.message}`);
                    }
                },
            });

            if (flags.json) {
                out.print(`${SafeJSON.stringify({ event: "result", ...result })}\n`);
            } else {
                out.println(
                    result.movie ? `${result.outcome}: ${result.movie}` : `${result.outcome}: ${result.folder}`
                );
            }

            if (result.outcome === "failed") {
                process.exitCode = 1;
            }

            if (flags.open && result.movie) {
                await ensureRecorderPart((line) => out.printlnErr(line));
                openEditor(result.folder);
            }
        } catch (error) {
            log.error({ error }, "recorder start failed");
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

for (const method of ["stop", "pause", "resume", "status"] as const) {
    program
        .command(method)
        .description(
            method === "status"
                ? "Print the live recording's state (the newest one, or the id given)"
                : `${method[0].toUpperCase()}${method.slice(1)} the live recording (the newest one, or the id given)`
        )
        .argument("[id]", "a live recording id, or its end (`tools recorder list --live`)")
        .action(async (id: string | undefined) => {
            try {
                const target = liveId(id);
                const answer = await callRecorder({
                    id: target,
                    method,
                    params: method === "stop" ? { wait: true } : undefined,
                });
                out.result(answer);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}

program
    .command("list")
    .description("The recordings library, newest first (or the running recordings with --live)")
    .option("--live", "the recordings that run now")
    .option("--limit <n>", "at most this many rows", "20")
    .option("--json", "JSON on stdout")
    .action((flags: { live?: boolean; limit: string; json?: boolean }) => {
        if (flags.live) {
            const entries = listLiveRecordings();
            if (flags.json) {
                out.result(entries);
                return;
            }

            const table = createBoxTable(["ID", "KIND", "STATE", "TITLE", "STARTED"]);
            for (const entry of entries) {
                table.push([entry.id, entry.kind, entry.state, entry.title, entry.startedAt]);
            }

            out.println(entries.length ? table.toString() : "No recording is running.");
            return;
        }

        const rows = listLibrary().slice(0, Math.max(1, Number(flags.limit) || 20));
        if (flags.json) {
            out.result(rows);
            return;
        }

        renderCliHeader("Recordings", `${rows.length} newest`);
        const table = createBoxTable(["ID", "TITLE", "STARTED", "MOVIE", "FRAMES", "EDITED"]);
        for (const row of rows) {
            table.push([
                row.id,
                row.title,
                row.startedAt.replace("T", " ").slice(0, 19),
                row.movie ? "yes" : "—",
                String(row.frames),
                row.edited ? "yes" : "",
            ]);
        }

        out.println(table.toString());
    });

program
    .command("edit")
    .description("Open a recording or a movie in the recorder's editor window")
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .option("--no-focus", "open it behind the front window without activating the app")
    .action(async (value: string, flags: { focus?: boolean }) => {
        try {
            const path = resolveRecording(value);

            if (!value.endsWith(".mp4") && !value.endsWith(".mov") && !value.endsWith(".json") && !movieOf(path)) {
                out.printlnErr("This recording has frames only; making proxy.mp4 for the editor…");
                await makeProxy(path);
            }

            await ensureRecorderPart((line) => out.printlnErr(line));
            openEditor(path, { focus: flags.focus !== false });
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

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

program
    .command("apply")
    .description(
        'Change a recording\'s edit with JSON ops, in order, saved once (the open editor window reloads it). Ops: {"op":"cut","from":4,"to":"0:09"}, split {at}, keep {from,to}, speed {from,to,factor}, zoom {from,to,scale?,focus?:{x,y},follow?}, unzoom {id}, autoZoom {scale?}, volume {volume 0–2}, mute {track,muted?}, audio {include}, exportSettings {codec?,maxHeight?,output?}, removeIdle {minSeconds? 2, keepSeconds? 0.3} (cuts still and silent stretches), reset. Times are source seconds or "mm:ss"'
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .argument("<ops>", "one op or an array of ops as JSON, or - to read them from stdin")
    .action(async (value: string, text: string) => {
        try {
            const raw = text === "-" ? await Bun.stdin.text() : text;
            const ops = parseEditOps(SafeJSON.parse(raw, { strict: true }));
            const edited = await editProject(value, ops);
            out.result(describeProject(edited.project, edited.path));
        } catch (error) {
            log.debug({ error }, "recorder apply failed");
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("export")
    .description(
        "Render a recording's edit (or a whole movie) to an MP4 with the editor's own renderer, without a window"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .option("--out <file>", "the movie to write (default <name>-edited.mp4 beside the source; never an existing file)")
    .option("--json", "the result as JSON")
    .action(async (value: string, flags: { out?: string; json?: boolean }) => {
        try {
            await ensureRecorderPart((line) => out.printlnErr(line));
            const answer = await exportEdit(resolveRecording(value), flags.out);

            if (flags.json) {
                out.result(answer);
            } else {
                out.println(
                    answer.ok ? `${answer.path} (${answer.bytes} bytes, ${answer.seconds} s)` : `error: ${answer.error}`
                );
            }

            if (!answer.ok) {
                process.exitCode = 1;
            }
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("proxy")
    .description(
        "Make proxy.mp4 for a frames-only recording (frames at their times, audio pieces mixed in), so the editor opens it"
    )
    .argument("<recording>", "a library id, `last` or a recording folder")
    .option("--display <id>", "the display whose frames to use (default the first frame's)")
    .action(async (value: string, flags: { display?: string }) => {
        try {
            const result = await makeProxy(resolveRecording(value), {
                displayId: flags.display === undefined ? undefined : Number(flags.display),
            });
            out.result(result);
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

await runTool(program, { tool: "recorder" });
