import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { isInteractive, runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { type TimeValue, timeSchema, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import { describeProject, EDIT_OP_NAMES, parseEditOps } from "@genesiscz/utils/recording-editor/project";
import { SUBTITLE_FORMATS, type SubtitleFormat } from "@genesiscz/utils/recording-editor/subtitles";
import { FILLER_WORDS } from "@genesiscz/utils/recording-editor/transcript-cuts";
import { FRAME_NAMINGS, OCR_SINK_KINDS } from "@genesiscz/utils/screen-recorder/frame-output";
import { renameRecording } from "@genesiscz/utils/screen-recorder/library";
import { callRecorder, type LiveEntry, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { FRAME_FLUSHES } from "@genesiscz/utils/screen-recorder/start";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { Command } from "commander";
import { registerServeCommand } from "./commands/serve";
import { demoScriptSchema, runDemo, scriptSteps } from "./lib/demo";
import {
    EXPORT_FORMATS,
    type ExportFormat,
    exportAs,
    finishExport,
    openProject,
    transcriptWords,
    writeSubtitles,
} from "./lib/edit";
import {
    keepingSwitchStep,
    keptPlan,
    prepareFramesMovie,
    restoreDisplayPlan,
    stepDisplaySwitch,
} from "./lib/frames-movie";
import { framesStartOf, recordFrames, refuseOtherKindFlags, wantsFrames } from "./lib/frames-recording";
import {
    alreadyInState,
    EDITOR_TABS,
    type EditorTab,
    ensureRecorderPart,
    listLibrary,
    liveRecordingRef,
    markerLabelProblem,
    movieOf,
    openEditor,
    openLibraryWindow,
    readEditorOpenState,
    resolveRecording,
    shortRecordingId,
    waitForEditorOpen,
} from "./lib/library";
import { chaptersOf, clickGroupsOf, markersOf, searchLibrary } from "./lib/moments";
import { applyEdit, undoLastEdit } from "./lib/movie-client";
import { type DisplayRange, PROXY_DISPLAY_POLICIES, type ProxyDisplay, parseDisplayPlan } from "./lib/proxy";
import { copyRecording, revealRecording, trashRecordings } from "./lib/quick-actions";
import { commentOn, commentsOf, importBoardComments, resolveComment, uncomment } from "./lib/review";
import { screenHitsWithOps } from "./lib/screen-ops";
import { findOnScreen } from "./lib/screen-search";
import { hostCloseEditor, hostOpenEditor } from "./lib/service-client";
import {
    checkTargetOnScreen,
    countdownSecondsOf,
    defaultStartTarget,
    otherRecordingsWarning,
    parseStartFlags,
    type StartFlags,
    withStartOptions,
} from "./lib/start-options";
import { Movie, movieDemoDriver } from "./lib/toolset";
import { recordVideo, tracksPointer } from "./lib/video-recording";

const { log } = logger.scoped("recorder");

/** `--display`: `most-change` or a display id. */
function parseProxyDisplay(raw: string): ProxyDisplay {
    if ((PROXY_DISPLAY_POLICIES as readonly string[]).includes(raw)) {
        return "most-change";
    }

    const id = Number(raw);

    if (!Number.isInteger(id) || id < 0) {
        throw new Error(`--display takes ${PROXY_DISPLAY_POLICIES.join(", ")} or a display id (got "${raw}")`);
    }

    return id;
}

/** `--switch 10:00-12:30=4`: a range on the recording's clock and the display it shows. */
function parseDisplaySwitch(raw: string): DisplayRange {
    const match = /^([^-=]+)-([^=]+)=(\d+)$/.exec(raw.trim());

    if (!match) {
        throw new Error(`--switch takes <from>-<to>=<display>, e.g. 10:00-12:30=4 (got "${raw}")`);
    }

    const fromUs = timeToUs(parseTime(match[1], "--switch"));
    const toUs = timeToUs(parseTime(match[2], "--switch"));

    if (toUs <= fromUs) {
        throw new Error(`--switch ${raw}: the end must come after the start`);
    }

    return { fromUs, toUs, displayId: Number(match[3]) };
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

/** The live recording a control command means: the one named, else the only one, else the newest. */
function liveId(id: string | undefined): string {
    return liveEntry(id).id;
}

function liveEntry(id: string | undefined): LiveEntry {
    const entries = listLiveRecordings();

    if (id) {
        const found = entries.find((entry) => entry.id === id || entry.id.endsWith(id));

        if (!found) {
            throw new Error(
                `No live recording "${id}". Running: ${entries.map((entry) => entry.id).join(", ") || "none"}`
            );
        }

        return found;
    }

    const newest = entries.at(-1);

    if (!newest) {
        throw new Error(`No recording is running. Start one with ${toolCommand("recorder start")}.`);
    }

    return newest;
}

function parseFormat(raw: string): ExportFormat {
    const format = EXPORT_FORMATS.find((candidate) => candidate === raw.toLowerCase());

    if (!format) {
        throw new Error(`--format takes ${EXPORT_FORMATS.join(", ")} (got "${raw}")`);
    }

    return format;
}

/**
 * The recording `tools recorder edit` opens when none is named: a list of the newest ones in a terminal, the library
 * window otherwise (undefined then, since the window opens the pick itself).
 */
async function pickRecording(): Promise<string | undefined> {
    const rows = listLibrary({ limit: 20 });

    if (!isInteractive() || rows.length === 0) {
        await ensureRecorderPart((line) => out.printlnErr(line));
        openLibraryWindow();
        out.printlnErr("Opened the recordings library: double-click a recording to edit it.");
        return undefined;
    }

    const picked = await p.select({
        message: "Which recording?",
        options: rows.map((row) => ({
            value: row.folder,
            label: row.title,
            hint: `${row.startedAt.slice(0, 16).replace("T", " ")}${row.edited ? " · edited" : ""}`,
        })),
    });

    return p.isCancel(picked) ? undefined : rows.find((row) => row.folder === picked)?.folder;
}

const program = new Command()
    .name("recorder")
    .description(
        "Screen recordings with a movie editor: record the screen, a window or an app with audio and the cursor, then cut, zoom and export in the recorder window or from the command line"
    );

/** The enumerated flags of a frames recording; a bare one asks in a terminal and lists its values elsewhere. */
const FRAMES_ENUM_FLAGS = [
    { key: "naming", flag: "--naming", values: FRAME_NAMINGS },
    { key: "flush", flag: "--flush", values: FRAME_FLUSHES },
    { key: "ocrSink", flag: "--ocr-sink", values: OCR_SINK_KINDS },
] as const;

/** False when a bare or unknown enumerated flag was answered with its values, or the question was cancelled. */
async function settleFramesEnumFlags(flags: StartFlags): Promise<boolean> {
    for (const { key, flag, values } of FRAMES_ENUM_FLAGS) {
        const given = flags[key];

        if (given === undefined || values.some((one) => one === given)) {
            continue;
        }

        if (given === true && isInteractive()) {
            const picked = await p.select({
                message: `${flag}`,
                options: values.map((one) => ({ value: one, label: one })),
            });

            if (p.isCancel(picked)) {
                return false;
            }

            flags[key] = String(picked);
            continue;
        }

        out.printlnErr(
            suggestEnumFlag("tools recorder", flag, values, {
                given: typeof given === "string" ? given : undefined,
            })
        );
        process.exitCode = 1;
        return false;
    }

    return true;
}

/** `tools recorder start --frames`: the REPL's `recorder.start()` from the command line. */
async function startFrames(flags: StartFlags): Promise<void> {
    if (!(await settleFramesEnumFlags(flags))) {
        return;
    }

    const start = framesStartOf(flags);
    const result = await recordFrames({
        start,
        countdownSeconds: countdownSecondsOf(flags.countdown),
        onStart: (recording) => {
            if (flags.json) {
                out.print(`${SafeJSON.stringify({ event: "started", id: recording.id, folder: recording.folder })}\n`);
            } else {
                out.printlnErr(`recording frames into ${recording.folder}`);
            }
        },
    });

    if (flags.json) {
        out.print(`${SafeJSON.stringify({ event: "result", ...result })}\n`);
    } else {
        const unread = result.ocrFailed ? `, ${result.ocrFailed} without their text: OCR failed` : "";
        out.println(`${result.outcome ?? result.state}: ${result.folder} (${result.frames ?? 0} frames${unread})`);

        for (const note of result.notes ?? []) {
            out.printlnErr(`note: ${note}`);
        }
    }

    if (result.outcome === "failed") {
        process.exitCode = 1;
    }
}

withStartOptions(
    program
        .command("start")
        .description(
            "Record a movie into the recordings library (screen.mp4 with audio tracks, cursor.jsonl, recording.json), or with --frames the frames of the displays (JPEG or the recorder's files, OCR into ocr.jsonl or beside each frame), as recorder.start() in the REPL does. Runs until the stop command, the menu bar item, the floating controls, Ctrl-C or --max-seconds; pausing leaves the paused time out"
        )
).action(async (flags: StartFlags) => {
    try {
        if (wantsFrames(flags)) {
            await startFrames(flags);
            return;
        }

        refuseOtherKindFlags(flags);
        const request = parseStartFlags(flags);
        // A fresh checkout compiles the native recorder first (up to a minute): say so before the silence.
        await ensureBinaryAsync({
            onBuild: () => {
                const message =
                    "building the native recorder (ax-tool) once; the first start in a checkout waits for it";
                if (flags.json) {
                    out.print(`${SafeJSON.stringify({ event: "preparing", message })}\n`);
                } else {
                    out.printlnErr(message);
                }
            },
        });
        if (request.target) {
            await checkTargetOnScreen(request.target);
        }

        const alongside = otherRecordingsWarning(listLiveRecordings());

        if (alongside) {
            if (flags.json) {
                out.print(
                    `${SafeJSON.stringify({ event: "warning", code: "another-recording", message: alongside })}\n`
                );
            } else {
                out.printlnErr(`note: ${alongside}`);
            }
        }

        const target = request.target ?? (await defaultStartTarget());

        if (!tracksPointer(target)) {
            out.printlnErr(
                "note: a window or app movie has no cursor track, so the editor draws no pointer, clicks or shortcuts; record --display or --region for those"
            );
        }

        const result = await recordVideo({
            ...request,
            target,
            onStarted: (recording) => {
                if (flags.json) {
                    out.print(`${SafeJSON.stringify({ event: "started", ...recording })}\n`);
                } else {
                    out.printlnErr(`recording into ${recording.folder} (live id ${recording.liveId})`);
                }
            },
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
            const rate = result.averageFps === undefined ? "" : ` (${result.frames} frames, ${result.averageFps} fps)`;
            out.println(
                result.movie
                    ? `${result.outcome}: ${result.movie}${rate}`
                    : result.removed
                      ? `failed, nothing was recorded: ${result.warnings[0] ?? "the capture did not start"}`
                      : `${result.outcome}: ${result.folder}`
            );
        }

        if (result.outcome === "failed" || result.cameraMissing) {
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
        .argument("[id]", `a live recording id, or its end (${toolCommand("recorder list --live")})`)
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
    .argument("[id]", `a live recording id, or its end (${toolCommand("recorder list --live")})`)
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

program
    .command("undo")
    .description(
        "Put an edit back as it was before its last change made with apply or the REPL (30 steps, across runs)"
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
    .command("copy")
    .description(
        "Copy a recording's movie (the newest export, else its own movie) to the clipboard as a file; --gif copies a GIF of the edit, exporting one when none is current"
    )
    .argument("<recording>", "a library id, `last` or a recording folder")
    .option("--gif", "a GIF of the edit instead of the movie")
    .action(async (value: string, flags: { gif?: boolean }) => {
        try {
            await ensureRecorderPart((line) => out.printlnErr(line));
            out.result(await copyRecording(resolveRecording(value), { gif: flags.gif }));
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("reveal")
    .description("Show a recording's folder in Finder; --meeting shows its meeting's record instead")
    .argument("<recording>", "a library id, `last` or a recording folder")
    .option("--meeting", "the meeting.json of a meeting's screen recording")
    .action(async (value: string, flags: { meeting?: boolean }) => {
        try {
            out.result(await revealRecording(resolveRecording(value), { meeting: flags.meeting }));
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("trash")
    .description(
        "Move library recordings through the removal policy, all in one call (tools rm trash lists the restore command). Run by an agent, or for a recording the policy does not allow, it asks the user: every such recording goes into ONE request they confirm with tools rm approve <id>. A meeting's screen recording is refused, and then nothing is moved"
    )
    .argument("<recording...>", "library ids, `last` or recording folders")
    .option("--no-aside", "keep the folders in the library while a request waits, instead of moving them aside")
    .action(async (values: string[], opts: { aside: boolean }) => {
        try {
            const folders = values.map((value) => resolveRecording(value));
            // RC24: one call per recording made one request each; one tools rm call makes at most one.
            out.result(await trashRecordings(folders, { askUser: true, ...(opts.aside ? {} : { aside: false }) }));
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

const reviewFail = (error: unknown) => {
    out.printlnErr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
};

const commentCommand = program
    .command("comment")
    .description(
        "Add a review comment at a time of the edit (OUTPUT seconds or m:ss, what plays); the editor shows it as a marker on the timeline. `comment add <recording> <at> <text>` is the same command"
    )
    .argument("<recording>", "a library id, `last`, `open` or a recording folder")
    .argument("<at>", "where it is: seconds, m:ss or h:mm:ss of what plays")
    .argument("<text>", "the comment")
    .option("--to <time>", "the end of the commented range")
    .option("--author <name>", "who wrote it")
    .option(
        "--link <url>",
        "the page it came from: a vitrinka annotation's link, a board's link (with --annotation), a PR"
    )
    .option("--annotation <number>", "the annotation's number on the board --link names: the comment opens it")
    .option("--source", "at and --to are times of the recording itself, not of the edit")
    // `comment add …` is taken here, not as a subcommand: commander would give an `add` subcommand's options to
    // `comment` itself, which has the same ones.
    .allowExcessArguments()
    .action(
        async (
            _recording: string,
            _at: string,
            _text: string,
            flags: { to?: string; author?: string; link?: string; annotation?: string; source?: boolean },
            command: Command
        ) => {
            try {
                const words = command.args;
                const named = words[0] === "add" ? words.slice(1) : words;

                if (named.length !== 3) {
                    throw new Error(
                        `comment${words[0] === "add" ? " add" : ""} takes <recording> <at> <text>, not ${named.length} words; quote a comment that has spaces`
                    );
                }

                if (flags.annotation !== undefined && !/^\d+$/.test(flags.annotation)) {
                    throw new Error(`--annotation takes the annotation's number, not "${flags.annotation}"`);
                }

                const [value, at, text] = named;
                out.result(
                    await commentOn(value, {
                        at: parseTime(at, "<at>"),
                        to: flags.to === undefined ? undefined : parseTime(flags.to, "--to"),
                        text,
                        author: flags.author,
                        link: flags.link,
                        annotation: flags.annotation === undefined ? undefined : Number(flags.annotation),
                        source: flags.source,
                    })
                );
            } catch (error) {
                reviewFail(error);
            }
        }
    );

commentCommand
    .command("import")
    .description(
        "Import a vitrinka board's annotations as review comments: each annotation on a shot, movie or step card (or on one --card) at the OUTPUT time its text starts with (0:42, 1:02:03, 42s), else at 0:00 with a note; a second import adds nothing"
    )
    .argument("<recording>", "a library id, `last`, `open` or a recording folder")
    .argument("<board>", "the board's link (a ?card= link picks that card), <workspace>/<slug> or its slug")
    .option("--card <id>", "only this card's annotations")
    .option("--dry-run", "read the board and show what would be added, write nothing")
    .action(async (value: string, board: string, flags: { card?: string; dryRun?: boolean }) => {
        try {
            if (flags.card !== undefined && !/^\d+$/.test(flags.card)) {
                throw new Error(`--card takes a card id (a number), not "${flags.card}"`);
            }

            out.result(
                await importBoardComments(value, {
                    board,
                    card: flags.card === undefined ? undefined : Number(flags.card),
                    dryRun: flags.dryRun,
                })
            );
        } catch (error) {
            reviewFail(error);
        }
    });

program
    .command("comments")
    .description("A recording's review comments in time order, with where each plays in the edit")
    .argument("<recording>", "a library id, `last`, `open` or a recording folder")
    .action(async (value: string) => {
        try {
            out.result(await commentsOf(value));
        } catch (error) {
            reviewFail(error);
        }
    });

program
    .command("resolve")
    .description("Mark a review comment done (--reopen opens it again)")
    .argument("<recording>", "a library id, `last`, `open` or a recording folder")
    .argument("<id>", `the comment's id (${toolCommand("recorder comments")} lists them)`)
    .option("--reopen", "open it again")
    .action(async (value: string, id: string, flags: { reopen?: boolean }) => {
        try {
            out.result(await resolveComment(value, id, !flags.reopen));
        } catch (error) {
            reviewFail(error);
        }
    });

program
    .command("uncomment")
    .description("Remove a review comment")
    .argument("<recording>", "a library id, `last`, `open` or a recording folder")
    .argument("<id>", "the comment's id")
    .action(async (value: string, id: string) => {
        try {
            out.result(await uncomment(value, id));
        } catch (error) {
            reviewFail(error);
        }
    });

program
    .command("demo")
    .description(
        "Record a finished demo from a JSON script of steps: each step is marked, its caption shows while it plays, the waiting between steps is cut, and the movie is exported (the REPL's movies.demo() runs code steps)"
    )
    .argument(
        "<script>",
        "a JSON file (or - for stdin) of { title?, record?: { audio, display, app, window, fps, camera }, edit?, steps: [{ caption, tools?: [words], shell?, wait?, holdSeconds? }] }"
    )
    .option("--no-export", "keep the edited recording without exporting a movie")
    .action(async (path: string, flags: { export?: boolean }) => {
        try {
            const raw = path === "-" ? await Bun.stdin.text() : readFileSync(resolve(path), "utf8");
            const parsed = demoScriptSchema.safeParse(SafeJSON.parse(raw, { strict: true }));

            if (!parsed.success) {
                const lines = parsed.error.issues.map(
                    (issue) => `  ${issue.path.join(".") || "(script)"}: ${issue.message}`
                );
                throw new Error(`the demo script does not parse:\n${lines.join("\n")}`);
            }

            const script = parsed.data;
            const result = await runDemo({
                steps: scriptSteps(script),
                driver: movieDemoDriver({ ...script.record, ...(script.title ? { title: script.title } : {}) }),
                edit: script.edit,
                settleSeconds: script.settleSeconds,
                holdSeconds: script.holdSeconds,
                export: flags.export !== false && script.export !== false,
            });

            for (const failure of result.failed) {
                out.printlnErr(`step "${failure.caption}" failed: ${failure.error}`);
            }

            out.printlnErr(
                result.exported
                    ? `demo: ${result.exported.path} (${result.steps.length} steps, ${result.sourceSeconds} s recorded)`
                    : `demo: ${result.folder} (${result.steps.length} steps, edited, not exported)`
            );
            out.result(result);
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
    .command("click-groups")
    .description(
        "The recorded clicks in groups (as autoZoom groups them), each with its count, source seconds and where it plays"
    )
    .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
    .option("--gap <seconds>", "a click under this many seconds after the one before joins its group (3)")
    .action(async (value: string, flags: { gap?: string }) => {
        try {
            const gapSeconds = flags.gap === undefined ? undefined : Number(flags.gap);

            if (gapSeconds !== undefined && !(gapSeconds >= 0.1 && gapSeconds <= 60)) {
                throw new Error(`--gap takes 0.1 to 60 seconds, not "${flags.gap}"`);
            }

            const groups = clickGroupsOf((await openProject(value)).project, { gapSeconds });

            for (const group of groups) {
                const plays = group.plays ? `plays ${group.plays.from}-${group.plays.to} s` : "cut, never plays";
                out.printlnErr(
                    `${group.count} click${group.count === 1 ? "" : "s"} at ${group.from}-${group.to} s (${plays}${group.cut && group.plays ? `, ${group.cut} cut` : ""})`
                );
            }

            if (!groups.length) {
                out.printlnErr("the cursor track has no clicks");
            }

            out.result(groups);
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
        "What to fix before an export (items and markers whose time is cut, texts a cut shortens, missing music, captions or subtitles without a transcript) and what to look at; changes nothing"
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

            const seen = [
                answer.zoom ? `zoom ${answer.zoom.scale}× (${answer.zoom.id})` : undefined,
                ...answer.redactions.map(
                    (part) => `${part.style === "spotlight" ? "spotlight" : "hidden part"} ${part.id}`
                ),
                ...answer.texts.map((note) => `text "${note.text}" (${note.id})`),
                ...answer.shapes.map((shape) => `${shape.kind} ${shape.id}`),
                answer.caption ? `caption "${answer.caption}"` : undefined,
            ].filter(Boolean);
            out.printlnErr(
                `at ${answer.output} s (source ${answer.source} s): ${seen.length ? seen.join(", ") : "nothing over the picture"}`
            );

            out.result(answer);
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("fix")
    .description(
        "Runs every fix `check` offers (removes what never shows, moves a cut marker to the nearest kept moment, lengthens what is too short to read, moves a text off another) in one save and one undo step"
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
                table.push([entry.id, entry.kind, entry.state, entry.title, formatLocalDateTimeStamp(entry.startedAt)]);
            }

            out.println(entries.length ? table.toString() : "No recording is running.");
            return;
        }

        const rows = listLibrary({ limit: Math.max(1, Number(flags.limit) || 20) });
        if (flags.json) {
            out.result(rows);
            return;
        }

        renderCliHeader("Recordings", `${rows.length} newest`);
        const table = createBoxTable(["ID", "TITLE", "STARTED", "LENGTH", "OUTCOME", "FRAMES", "EDITED"]);
        const clock = (ms: number) => {
            const seconds = Math.round(ms / 1000);
            return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        };
        for (const row of rows) {
            table.push([
                shortRecordingId(row.id),
                row.title,
                formatLocalDateTimeStamp(row.startedAt),
                row.durationMs === undefined ? (row.movie ? "movie" : "—") : clock(row.durationMs),
                row.outcome ?? "—",
                String(row.frames),
                row.edited ? "yes" : "",
            ]);
        }

        out.println(table.toString());
        out.println("Every command takes the short id; --json has the full ids, folders and why a failed one failed.");
    });

program
    .command("library")
    .description("Open the recordings library window: double-click a recording to edit it")
    .option("--no-focus", "open it behind the front window without activating the app")
    .action(async (flags: { focus?: boolean }) => {
        await ensureRecorderPart((line) => out.printlnErr(line));
        openLibraryWindow({ focus: flags.focus !== false });
    });

program
    .command("opened")
    .description("The recordings open in the editor and the one in front; `open` names it in every other command")
    .option("--wait [seconds]", "wait until the editor brings a recording to the front, then print it", "")
    .option("--json", "print as JSON")
    .action(async (flags: { wait: string | boolean; json?: boolean }) => {
        if (flags.wait !== "") {
            const seconds = typeof flags.wait === "string" ? Number(flags.wait) : 600;
            const front = await waitForEditorOpen({ timeoutMs: (Number.isFinite(seconds) ? seconds : 600) * 1000 });
            out.result(flags.json ? front : front.path);
            return;
        }

        const state = readEditorOpenState();

        if (flags.json) {
            out.result(state ?? { open: [] });
            return;
        }

        if (!state?.open.length) {
            out.printlnErr(`No recording is open in the editor. Pick one: ${toolCommand("recorder library")}`);
            return;
        }

        for (const row of state.open) {
            out.println(`${row.path === state.front?.path ? "▶" : " "} ${row.title}  ${row.path}`);
        }
    });

program
    .command("edit")
    .description("Open a recording or a movie in the recorder's editor window (no recording: pick one)")
    .argument("[recording]", "a library id, `last`, `open`, a recording folder, a movie or an edit.json")
    .option("--no-focus", "open it behind the front window without activating the app")
    .option("--at <time>", "put the playhead at this OUTPUT time (seconds or m:ss)")
    .option("--tab [name]", `open this inspector tab: ${EDITOR_TABS.join(", ")}`)
    .action(async (given: string | undefined, flags: { focus?: boolean; at?: string; tab?: string | boolean }) => {
        try {
            const value = given ?? (await pickRecording());

            if (!value) {
                return;
            }

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
                await prepareFramesMovie(path, {});
            }

            await ensureRecorderPart((line) => out.printlnErr(line));
            // What opened, so an agent needs no second call (`tools recorder opened`) to know it worked.
            out.result({ ...(await hostOpenEditor(path, { focus: flags.focus !== false, atSeconds, tab })), path });
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

const windowCommand = program
    .command("window")
    .description(
        `The recorder's editor windows: \`edit\` opens one, \`opened\` lists them, \`window close\` closes one`
    );

windowCommand
    .command("close")
    .description(
        "Close a recording's editor window, as its close button does; refused while the window has a drag not saved yet or an export running"
    )
    .argument(
        "[recording]",
        "a library id, `last`, `open` (the one in front), a recording folder, a movie or an edit.json"
    )
    .option(
        "--window <number>",
        `the window number ${toolCommand("recorder opened --json")} lists, instead of a recording`
    )
    .option("--json", "print the answer as JSON")
    .action(async (given: string | undefined, flags: { window?: string; json?: boolean }) => {
        try {
            if (given === undefined && flags.window === undefined) {
                throw new Error(
                    `name the recording, or --window <number>; ${toolCommand("recorder opened")} lists the open ones`
                );
            }

            if (flags.window !== undefined && !/^\d+$/.test(flags.window)) {
                throw new Error(`--window takes a window number, not "${flags.window}"`);
            }

            const answer = await hostCloseEditor(
                flags.window !== undefined ? { window: Number(flags.window) } : { path: resolveRecording(given ?? "") }
            );

            if (flags.json) {
                out.result(answer);
                return;
            }

            out.println(
                answer.closed ? `Closed editor window ${answer.window ?? ""}`.trim() : "No editor window shows it."
            );
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

            // A skipped step is said too: a subtitle file only when the edit asks for one.
            if (!answer.subtitles && !answer.warnings?.some((warning) => warning.startsWith("no subtitles"))) {
                out.printlnErr(
                    `no subtitles: the edit asks for none (${toolCommand("recorder export", value, "--subtitles", "srt")} writes them)`
                );
            }
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("cut-words")
    .description(
        "Cut words out of the transcript line spoken at a source time (every place that line says them, or --occurrence); one undo"
    )
    .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
    .requiredOption("--at <time>", "any source time inside the line (seconds, m:ss or h:mm:ss)")
    .requiredOption("--words <text>", "the word or words, in order")
    .option("--occurrence <n>", "only this place of the words in the line (1 is the first)")
    .option("--pad-ms <ms>", "kept off the words' edges", "40")
    .option("--dry-run", "list what it would cut, save nothing")
    .action(
        async (
            value: string,
            flags: { at: string; words: string; occurrence?: string; padMs?: string; dryRun?: boolean }
        ) => {
            try {
                const movie = new Movie(value);
                out.result(
                    await movie.cutWords({
                        at: parseTime(flags.at, "--at"),
                        words: flags.words,
                        ...(flags.occurrence !== undefined ? { occurrence: Number(flags.occurrence) } : {}),
                        padMs: Number(flags.padMs ?? 40),
                        dryRun: flags.dryRun,
                    })
                );
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        }
    );

program
    .command("words")
    .description(
        "The words of each transcript line as cut-words splits and times them (the editor's word pick reads this)"
    )
    .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
    .option("--at <time>", "only the line spoken at this source time (seconds, m:ss or h:mm:ss)")
    .action(async (value: string, flags: { at?: string }) => {
        try {
            out.result(await transcriptWords(value, flags.at ? { at: parseTime(flags.at, "--at") } : {}));
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("cut-fillers")
    .description(
        `Cut every filler word of the transcript in one step (${Object.keys(FILLER_WORDS).join(", ")} lists, or --words); one undo`
    )
    .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
    .option(
        "--lang <code>",
        `the filler list: ${Object.entries(FILLER_WORDS)
            .map(([code, list]) => `${code} (${list.sounds.join(", ")}; with --all also ${list.words.join(", ")})`)
            .join("; ")}; default every language`
    )
    .option("--all", "also the fillers that are real words (jako, like): check with --dry-run first")
    .option("--words <list>", "your own filler words, comma-separated")
    .option("--pad-ms <ms>", "kept off each cut's edges", "40")
    .option("--dry-run", "list what it would cut, save nothing")
    .action(
        async (
            value: string,
            flags: { lang?: string; all?: boolean; words?: string; padMs?: string; dryRun?: boolean }
        ) => {
            try {
                const answer = await new Movie(value).cutFillers({
                    ...(flags.lang ? { language: flags.lang } : {}),
                    level: flags.all ? "all" : "sounds",
                    ...(flags.words ? { words: flags.words.split(",").map((word) => word.trim()) } : {}),
                    padMs: Number(flags.padMs ?? 40),
                    dryRun: flags.dryRun,
                });
                out.result(answer);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        }
    );

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
    .argument("<recording>", "a library id, `last`, a meeting id or a recording folder")
    .option("--display <display>", "most-change (default: per window the display that changed most) or a display id")
    .option("--window <seconds>", "the window most-change picks a display for", "10")
    .option(
        "--switch <from-to=display...>",
        "show this display in this range whatever the policy picks, e.g. 10:00-12:30=4 (repeatable)"
    )
    .option(
        "--keep-plan",
        "keep the display plan of the last proxy (proxy.json) and lay the --switch ranges over it, as the editor does"
    )
    .option(
        "--plan <file>",
        "make it with exactly the display plan in this file (a copy of an earlier proxy.json); not with --display, --switch or --keep-plan"
    )
    .option(
        "--undo-switch",
        "take the last display switch back: the movie is made again with the plan from before it (proxy.undo.json), as the editor's ⌘Z does"
    )
    .option("--redo-switch", "make the last undone display switch again")
    .action(
        async (
            value: string,
            flags: {
                display?: string;
                window?: string;
                switch?: string[];
                keepPlan?: boolean;
                plan?: string;
                undoSwitch?: boolean;
                redoSwitch?: boolean;
            }
        ) => {
            try {
                const folder = resolveRecording(value);

                if (flags.undoSwitch || flags.redoSwitch) {
                    if (
                        (flags.undoSwitch && flags.redoSwitch) ||
                        flags.plan ||
                        flags.display !== undefined ||
                        flags.switch?.length ||
                        flags.keepPlan
                    ) {
                        throw new Error("--undo-switch and --redo-switch take only the recording");
                    }

                    out.result(await stepDisplaySwitch(folder, flags.undoSwitch ? "undo" : "redo"));
                    return;
                }

                if (flags.plan) {
                    if (flags.display !== undefined || flags.switch?.length || flags.keepPlan) {
                        throw new Error(
                            "--plan is the whole display plan; give it without --display, --switch or --keep-plan"
                        );
                    }

                    const plan = parseDisplayPlan(SafeJSON.parse(readFileSync(flags.plan, "utf8"), { strict: true }));
                    out.result(await restoreDisplayPlan(folder, plan));
                    return;
                }

                const display = flags.display === undefined ? undefined : parseProxyDisplay(flags.display);
                const switches = (flags.switch ?? []).map(parseDisplaySwitch);
                const make = () =>
                    prepareFramesMovie(folder, {
                        ...(display !== undefined ? { display } : {}),
                        windowSec: Number(flags.window ?? 10),
                        ...(flags.keepPlan ? keptPlan(folder, switches) : { overrides: switches }),
                    });
                // A switch is one step that --undo-switch, the REPL and the editor take back.
                out.result(switches.length > 0 ? await keepingSwitchStep(folder, make) : await make());
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        }
    );

/** The source length of a recording's movie in seconds, to keep the hits' ops inside it; undefined without a movie. */
async function movieSeconds(folder: string): Promise<number | undefined> {
    try {
        return (await openProject(folder)).project.source.durationUs / 1_000_000;
    } catch (error) {
        log.debug({ error, folder }, "find-screen: no movie, so the ops keep the frames' own ends");
        return undefined;
    }
}

program
    .command("find-screen")
    .description("Where a text was on the screen of a frames recording or a meeting (OCR), at source seconds")
    .argument("<recording>", "a library id, `last`, a meeting id or a recording folder")
    .argument("<text>", "the text to look for (case and accents ignored)")
    .option("--limit <n>", "at most this many frames", "50")
    .option("--json", "print JSON")
    .action(async (value: string, text: string, flags: { limit?: string; json?: boolean }) => {
        try {
            const folder = resolveRecording(value);
            const hits = findOnScreen(folder, text, { limit: Number(flags.limit ?? 50) });

            if (flags.json) {
                out.result(screenHitsWithOps(hits, await movieSeconds(folder)));
                return;
            }

            for (const hit of hits) {
                const clock = new Date(hit.sec * 1000).toISOString().slice(11, 19);
                out.println(
                    `${clock}  d${hit.displayId ?? "?"}${hit.shown ? "" : " (not the shown display)"}  ${hit.lines.join(" | ")}`
                );
            }

            if (hits.length === 0) {
                out.printlnErr(`No frame shows "${text}".`);
            }
        } catch (error) {
            out.printlnErr(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

registerServeCommand(program);

await runTool(program, { tool: "recorder" });
