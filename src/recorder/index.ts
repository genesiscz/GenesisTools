import { resolve } from "node:path";
import { defaultRecordingTarget, listRecordingTargets, type RecordingTarget } from "@app/control/lib/recording-targets";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { type TimeValue, timeSchema, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import { describeProject, EDIT_OP_NAMES, parseEditOps } from "@genesiscz/utils/recording-editor/project";
import { SUBTITLE_FORMATS, type SubtitleFormat } from "@genesiscz/utils/recording-editor/subtitles";
import { renameRecording } from "@genesiscz/utils/screen-recorder/library";
import { callRecorder, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { Command } from "commander";

import {
    EXPORT_FORMATS,
    type ExportFormat,
    editProject,
    exportAs,
    finishExport,
    openProject,
    undoEdit,
    writeSubtitles,
} from "./lib/edit";
import {
    EDITOR_TABS,
    type EditorTab,
    ensureRecorderPart,
    listLibrary,
    movieOf,
    openEditor,
    resolveRecording,
} from "./lib/library";
import { chaptersOf, markersOf, searchLibrary } from "./lib/moments";
import { makeProxy } from "./lib/proxy";
import { Movie } from "./lib/toolset";
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
    systemCursor?: boolean;
    shortcuts?: boolean;
    controls?: boolean;
    open?: boolean;
    json?: boolean;
}

/** A `--from`/`--to` time: seconds or m:ss, with a plain message instead of a zod dump. */
function parseTime(raw: string, flag: string): TimeValue {
    const parsed = timeSchema.safeParse(raw);

    if (!parsed.success) {
        throw new Error(`${flag} takes seconds, m:ss or h:mm:ss (got "${raw}")`);
    }

    return parsed.data;
}

function parseSubtitleFormat(raw: string): SubtitleFormat {
    const found = SUBTITLE_FORMATS.find((format) => format === raw);

    if (!found) {
        throw new Error(`the subtitle format is one of ${SUBTITLE_FORMATS.join(", ")} (got "${raw}")`);
    }

    return found;
}

/** A `--tab` value: the tab, or null when it is missing or not one of EDITOR_TABS. */
function editorTab(raw: string | boolean): EditorTab | null {
    const found = EDITOR_TABS.find((tab) => tab === raw);
    return found ?? null;
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
        throw new Error(`--audio takes system, mic or system,mic (got "${raw}")`);
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

function parseFormat(raw: string): ExportFormat {
    const format = EXPORT_FORMATS.find((candidate) => candidate === raw.toLowerCase());

    if (!format) {
        throw new Error(`--format takes ${EXPORT_FORMATS.join(", ")} (got "${raw}")`);
    }

    return format;
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
    .option(
        "--no-shortcuts",
        "do not keep the ⌘/⌃ shortcuts pressed (by default they go into the cursor track for the keys overlay; plain typing never does)"
    )
    .option(
        "--system-cursor",
        "keep the system cursor in the movie (by default it stays out and the editor draws it: smoothed, any size)"
    )
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
                systemCursor: flags.systemCursor,
                shortcuts: flags.shortcuts,
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
            log.debug({ error }, "recorder start failed");
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
    .command("mark")
    .description("Mark this moment of the live recording with a label; the editor and movie.markers() show it")
    .argument("<label>", "what happened (1 to 80 characters)")
    .argument("[id]", "a live recording id, or its end (`tools recorder list --live`)")
    .action(async (label: string, id: string | undefined) => {
        try {
            out.result(await callRecorder({ id: liveId(id), method: "marker.add", params: { label } }));
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("undo")
    .description(
        "Put an edit back as it was before its last change made with apply or the REPL (30 steps, across runs)"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .action(async (value: string) => {
        try {
            const undone = await undoEdit(value);
            out.result({ undone: undone.undone ?? [], ...describeProject(undone.project, undone.path) });
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("rename")
    .description("Give a recording a new title (the library, the editor window and movies.list() show it)")
    .argument("<recording>", "a library id, `last` or a recording folder")
    .argument("<title>", "the new title (1 to 120 characters)")
    .action((value: string, title: string) => {
        try {
            const manifest = renameRecording(resolveRecording(value), title);
            out.result({ id: manifest.id, title: manifest.title });
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("markers")
    .description("The moments marked while a recording ran, with where each plays in its edit (null when cut)")
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .option("--chapters", 'as "0:00 Intro" chapter lines for a video description (cut markers left out)')
    .action(async (value: string, flags: { chapters?: boolean }) => {
        try {
            const opened = await openProject(value);

            if (flags.chapters) {
                out.print(`${chaptersOf(markersOf(opened)).join("\n")}\n`);
                return;
            }

            out.result(markersOf(opened));
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("replace-words")
    .description(
        "Replace a word or phrase in every transcript line (captions and subtitles show the fixed words); one undo"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .requiredOption("--find <text>", "the words to find (whole words, any case)")
    .requiredOption("--replace <text>", "what goes in their place")
    .option("--match-case", "only where the case matches too")
    .option("--part-of-word", "also inside longer words")
    .action(
        async (value: string, flags: { find: string; replace: string; matchCase?: boolean; partOfWord?: boolean }) => {
            try {
                const answer = await new Movie(value).replaceWords({
                    find: flags.find,
                    replace: flags.replace,
                    matchCase: flags.matchCase,
                    wholeWord: !flags.partOfWord,
                });
                out.printlnErr(`replaced in ${answer.replaced.length} line${answer.replaced.length === 1 ? "" : "s"}`);
                out.result({ replaced: answer.replaced });
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        }
    );

program
    .command("check")
    .description(
        "What to fix before an export (items whose time is cut, missing music, captions or subtitles without a transcript) and what to look at; changes nothing"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .action(async (value: string) => {
        try {
            const answer = await new Movie(value).check();

            for (const issue of answer.issues) {
                out.printlnErr(
                    `${issue.severity === "fix" ? "fix  " : "check"}  ${issue.message}${issue.fix ? `  (${issue.fix})` : ""}`
                );
            }

            if (!answer.issues.length) {
                out.printlnErr("nothing to fix or check");
            }

            out.result(answer);
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("items-at")
    .description(
        "What plays at an OUTPUT time of the edit, in words: the source time, the zoom, hidden parts, texts, shapes and the caption line"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .argument("<at>", 'output seconds or "m:ss"')
    .action(async (value: string, at: string) => {
        try {
            const answer = await new Movie(value).itemsAt(/^\d+(\.\d+)?$/.test(at) ? Number(at) : at);

            for (const warning of answer.warnings ?? []) {
                out.printlnErr(warning);
            }

            out.result(answer);
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("fix")
    .description(
        "Runs every fix `check` offers (removes what never shows, lengthens what is too short to read, moves a text off another) in one save and one undo step"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .action(async (value: string) => {
        try {
            const answer = await new Movie(value).fix();

            for (const message of answer.fixed) {
                out.printlnErr(`fixed  ${message}`);
            }

            for (const warning of answer.warnings ?? []) {
                out.printlnErr(warning);
            }

            out.result(answer);
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("sheet")
    .description("Several frames of the edit as it exports on one PNG, in rows of three, each labelled with its time")
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .option("--count <n>", "frames spread over the range (default 6, at most 12)")
    .option("--from <time>", "the range's start in OUTPUT seconds or m:ss (default 0)")
    .option("--to <time>", "the range's end (default the end of the edit)")
    .option("--at <times>", "these OUTPUT times instead, comma-separated (2,5.5,0:12)")
    .option("--out <png>", "where the picture goes (default a temporary file)")
    .action(async (value: string, flags: { count?: string; from?: string; to?: string; at?: string; out?: string }) => {
        try {
            await ensureRecorderPart((line) => out.printlnErr(line));
            const answer = await new Movie(value).sheet({
                count: flags.count === undefined ? undefined : Number(flags.count),
                from: flags.from === undefined ? undefined : parseTime(flags.from, "--from"),
                to: flags.to === undefined ? undefined : parseTime(flags.to, "--to"),
                at: flags.at?.split(",").map((time) => parseTime(time.trim(), "--at")),
                out: flags.out === undefined ? undefined : resolve(flags.out),
            });
            out.result(answer);
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("search")
    .description(
        "Find a moment across the library: titles, marker labels and cached transcript lines (case and accents ignored)"
    )
    .argument("<text>", "what to look for")
    .option("--json", "JSON on stdout")
    .action((text: string, flags: { json?: boolean }) => {
        const hits = searchLibrary(text);

        if (flags.json) {
            out.result(hits);
            return;
        }

        if (!hits.length) {
            out.println(`Nothing in the library matches "${text}".`);
            return;
        }

        const table = createBoxTable(["RECORDING", "KIND", "AT", "TEXT"]);
        for (const hit of hits) {
            table.push([hit.recording, hit.kind, `${hit.at.toFixed(1)} s`, hit.text.slice(0, 80)]);
        }

        out.println(table.toString());
    });

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
    .option("--at <time>", "put the playhead at this OUTPUT time (seconds or m:ss)")
    .option("--tab [name]", `open this inspector tab: ${EDITOR_TABS.join(", ")}`)
    .action(async (value: string, flags: { focus?: boolean; at?: string; tab?: string | boolean }) => {
        try {
            const tab = flags.tab === undefined ? undefined : editorTab(flags.tab);

            if (tab === null) {
                out.printlnErr(
                    suggestEnumFlag("tools recorder", "--tab", EDITOR_TABS, {
                        given: typeof flags.tab === "string" ? flags.tab : undefined,
                    })
                );
                process.exitCode = 1;
                return;
            }

            const atSeconds = flags.at === undefined ? undefined : timeToUs(parseTime(flags.at, "--at")) / 1_000_000;
            const path = resolveRecording(value);

            if (!value.endsWith(".mp4") && !value.endsWith(".mov") && !value.endsWith(".json") && !movieOf(path)) {
                out.printlnErr("This recording has frames only; making proxy.mp4 for the editor…");
                await makeProxy(path);
            }

            await ensureRecorderPart((line) => out.printlnErr(line));
            openEditor(path, { focus: flags.focus !== false, atSeconds, tab });
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
        `Change a recording's edit with JSON ops, in order, saved once (the open editor window reloads it), e.g. {"op":"cut","from":4,"to":"0:09"}. Ops: ${EDIT_OP_NAMES.join(", ")}; a wrong or missing field names the right ones, and the REPL's help("movies") documents each. Times are source seconds or "mm:ss"`
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .argument("<ops>", "one op or an array of ops as JSON, or - to read them from stdin")
    .action(async (value: string, text: string) => {
        try {
            const raw = text === "-" ? await Bun.stdin.text() : text;
            const ops = parseEditOps(SafeJSON.parse(raw, { strict: true }));
            const edited = await editProject(value, ops);
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

program
    .command("export")
    .description(
        "Render a recording's edit (or a whole movie) to an MP4 with the editor's own renderer, without a window"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .option(
        "--out <file>",
        "the file to write (default <name>-edited.<format> beside the source; never an existing file)"
    )
    .option(
        "--format <format>",
        `${EXPORT_FORMATS.join(", ")} (default the --out extension, else mp4; a gif is 10 fps, at most 960 wide)`
    )
    .option("--from <time>", "export only the part from this OUTPUT time (seconds or m:ss; what plays)")
    .option("--to <time>", "export only the part up to this OUTPUT time")
    .option("--subtitles <format>", "also write the transcript beside the movie: srt or vtt")
    .option("--json", "the result as JSON")
    .action(
        async (
            value: string,
            flags: { out?: string; format?: string; from?: string; to?: string; subtitles?: string; json?: boolean }
        ) => {
            try {
                await ensureRecorderPart((line) => out.printlnErr(line));
                const part =
                    flags.from === undefined && flags.to === undefined
                        ? undefined
                        : {
                              fromUs: flags.from === undefined ? 0 : timeToUs(parseTime(flags.from, "--from")),
                              toUs:
                                  flags.to === undefined
                                      ? Number.MAX_SAFE_INTEGER
                                      : timeToUs(parseTime(flags.to, "--to")),
                          };
                const answer = await exportAs(value, {
                    out: flags.out,
                    format: flags.format === undefined ? undefined : parseFormat(flags.format),
                    part,
                    subtitles: flags.subtitles === undefined ? undefined : parseSubtitleFormat(flags.subtitles),
                });

                if (flags.json) {
                    out.result(answer);
                } else {
                    out.println(
                        answer.ok
                            ? `${answer.path} (${answer.bytes} bytes, ${answer.seconds} s${answer.chapters ? `, ${answer.chapters} chapters` : ""})${answer.subtitles ? `\n${answer.subtitles}` : ""}`
                            : `error: ${answer.error}`
                    );

                    for (const warning of answer.warnings ?? []) {
                        out.printlnErr(warning);
                    }
                }

                if (!answer.ok) {
                    process.exitCode = 1;
                }
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        }
    );

program
    .command("finish")
    .description(
        "After an export: write the subtitle file and put the markers into an MP4 as chapters, by the edit's settings"
    )
    .argument("<recording>", "the edit the movie was exported from")
    .argument("<movie>", "the exported movie")
    .option("--from <time>", "the movie holds only the part from this OUTPUT time (seconds or m:ss)")
    .option("--to <time>", "the movie holds only the part up to this OUTPUT time")
    .action(async (value: string, movie: string, flags: { from?: string; to?: string }) => {
        try {
            const part =
                flags.from === undefined && flags.to === undefined
                    ? undefined
                    : {
                          fromUs: flags.from === undefined ? 0 : timeToUs(parseTime(flags.from, "--from")),
                          toUs:
                              flags.to === undefined ? Number.MAX_SAFE_INTEGER : timeToUs(parseTime(flags.to, "--to")),
                      };
            const answer = await finishExport({ value, answer: { ok: true, path: resolve(movie) }, part });
            out.result(answer);

            for (const warning of answer.warnings ?? []) {
                out.printlnErr(warning);
            }
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("subtitles")
    .description(
        "Write a recording's transcript as a subtitle file in the edit's time (cut lines left out, fixes kept)"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .option("--format <format>", "srt (default) or vtt")
    .option("--out <file>", "the file to write (default beside the movie, named like its export)")
    .option("--from <time>", "only the part from this OUTPUT time, moved to start at 0 (an exported part)")
    .option("--to <time>", "only the part up to this OUTPUT time")
    .action(async (value: string, flags: { format?: string; out?: string; from?: string; to?: string }) => {
        try {
            const part =
                flags.from === undefined && flags.to === undefined
                    ? undefined
                    : {
                          fromUs: flags.from === undefined ? 0 : timeToUs(parseTime(flags.from, "--from")),
                          toUs:
                              flags.to === undefined ? Number.MAX_SAFE_INTEGER : timeToUs(parseTime(flags.to, "--to")),
                      };
            out.result(
                await writeSubtitles({
                    value,
                    format: flags.format === undefined ? "srt" : parseSubtitleFormat(flags.format),
                    out: flags.out,
                    part,
                })
            );
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
