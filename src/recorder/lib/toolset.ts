import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { timeSchema } from "@genesiscz/utils/recording-editor/plan";
import {
    describeProject,
    type EditOp,
    type EditProject,
    editOpSchema,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { callRecorder, type LiveEntry, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { z } from "zod";
import { editProject, openProject } from "./edit";
import { ensureRecorderPart, exportEdit, listLibrary, openEditor } from "./library";

const { log } = logger.scoped("recorder-toolset");

const START_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

const range = { from: timeSchema, to: timeSchema };
const focusSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const zoomSchema = z
    .object({
        ...range,
        scale: z.number().min(1).max(4).optional(),
        focus: focusSchema.optional(),
        follow: z.boolean().optional(),
    })
    .strict();
const recordSchema = z
    .object({
        audio: z.array(z.enum(["system", "mic"])).optional(),
        title: z.string().optional(),
        maxSeconds: z
            .number()
            .min(1)
            .max(4 * 60 * 60)
            .optional(),
        display: z.number().int().min(0).optional(),
        app: z.string().optional(),
        window: z.array(z.number().int()).optional(),
        fps: z.number().min(1).max(120).optional(),
        controls: z.boolean().optional(),
        /** The red border around what is recorded (never in the movie). */
        indicator: z.boolean().optional(),
    })
    .strict();

const movieDoc = "{ path, revision, sourceSeconds, outputSeconds, clips, zooms, audio, export }";
const edit = (name: string, params: z.ZodType, doc: string, positional?: string[]) =>
    defineMethod({ name, params, positional, result: z.unknown(), resultName: movieDoc, doc, effect: "reversible" });

const movieMethods = [
    defineMethod({
        name: "info",
        params: z.object({}),
        result: z.unknown(),
        resultName: movieDoc,
        doc: "The edit as it is on disk now (the window may have changed it).",
        effect: "read",
    }),
    edit("split", z.object({ at: timeSchema }), "Splits the clip at a source time.", ["at"]),
    edit("cut", z.object(range), "Removes a source range from the movie.", ["from", "to"]),
    edit("keep", z.object(range), "Keeps only a source range (trims both ends).", ["from", "to"]),
    edit(
        "speed",
        z.object({ ...range, factor: z.number().min(0.25).max(16) }),
        "Plays a source range faster (2) or slower (0.5).",
        ["from", "to", "factor"]
    ),
    edit(
        "zoom",
        zoomSchema,
        "Zooms over a source range: scale 1–4, focus {x,y} 0..1 from the top left, or follow: true for the cursor."
    ),
    edit("unzoom", z.object({ id: z.string() }), "Removes a zoom by its id.", ["id"]),
    edit(
        "autoZoom",
        z.object({ scale: z.number().min(1).max(4).optional() }).strict(),
        "One zoom per group of recorded clicks, following the cursor; replaces earlier auto zooms, keeps manual ones, and throws when there are no clicks."
    ),
    edit("volume", z.object({ volume: z.number().min(0).max(2) }), "Sets the volume, 0 to 2.", ["volume"]),
    edit("mute", z.object({ track: z.number().int().nonnegative() }), "Mutes an audio track (0 is the first).", [
        "track",
    ]),
    edit("unmute", z.object({ track: z.number().int().nonnegative() }), "Unmutes an audio track.", ["track"]),
    edit("apply", z.object({ ops: z.array(editOpSchema).min(1) }), "Several ops at once, saved once.", ["ops"]),
    edit("undo", z.object({}), "Puts back the edit as it was before this handle's last change."),
    edit("reset", z.object({}), "Starts over: the whole movie, no zooms, default audio and export."),
    defineMethod({
        name: "export",
        params: z.object({ out: z.string().optional() }).strict(),
        result: z.unknown(),
        resultName: "{ path, bytes, outputSeconds, width, height, renderSeconds }",
        doc: "Renders the edit to an MP4 with the editor's renderer; throws when the file exists (it never overwrites).",
        effect: "reversible",
    }),
    defineMethod({
        name: "show",
        params: z.object({ focus: z.boolean().optional() }).strict(),
        result: z.unknown(),
        doc: "Opens the edit in the recorder window (behind the front window unless focus: true).",
        effect: "reversible",
    }),
];

const recordingMethods = [
    defineMethod({
        name: "status",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ state, elapsedMs, limitMs, segments }",
        doc: "The recording's state.",
        effect: "read",
    }),
    defineMethod({ name: "pause", params: z.object({}), result: z.unknown(), doc: "Pauses.", effect: "reversible" }),
    defineMethod({ name: "resume", params: z.object({}), result: z.unknown(), doc: "Resumes.", effect: "reversible" }),
    defineMethod({
        name: "stop",
        params: z.object({}),
        result: z.unknown(),
        resultName: "Movie",
        doc: "Stops, waits for the movie, and returns it as a Movie to edit.",
        effect: "reversible",
    }),
];

export const moviesApi = defineApi({
    id: "movies",
    global: "movies",
    title: "Movie recorder and editor",
    summary:
        "Record the screen as a movie, then cut, speed up, zoom and export it; the recorder window shows each edit.",
    methods: [
        defineMethod({
            name: "list",
            params: z.object({ limit: z.number().int().positive().optional() }).strict(),
            result: z.unknown(),
            resultName: "{ id, title, folder, startedAt, movie?, edited }[]",
            doc: "The recordings library, newest first.",
            effect: "read",
        }),
        defineMethod({
            name: "open",
            params: z.object({ recording: z.string() }),
            positional: ["recording"],
            result: z.unknown(),
            resultName: "Movie",
            doc: 'A library id, "last", a recording folder, a movie or an edit.json.',
            effect: "read",
        }),
        defineMethod({
            name: "record",
            params: recordSchema,
            result: z.unknown(),
            resultName: "MovieRecording",
            doc: "Starts a movie recording of the main display (or display, app, window) in its own process.",
            effect: "reversible",
        }),
    ],
    handles: [
        { name: "Movie", summary: "One recording's edit (edit.json).", methods: movieMethods },
        { name: "MovieRecording", summary: "A movie recording that runs now.", methods: recordingMethods },
    ],
    notes: [
        'Times are SOURCE seconds (the movie as recorded) or "mm:ss": a cut never moves later times.',
        "Every edit reads the file fresh and saves once, so the open window and you never overwrite each other.",
        'The edit is a file: it stays after the worker ends, and the next run starts from it. apply([{ op: "reset" }]) starts over; undo() reaches only the changes of this handle.',
        "Limits: speed 0.25–16, zoom scale 1–4, focus x and y 0–1, volume 0–2.",
    ],
});

export class Movie {
    private readonly history: EditProject[] = [];

    constructor(readonly recording: string) {}

    async info() {
        const opened = await openProject(this.recording);
        return describeProject(opened.project, opened.path);
    }

    private async change(ops: EditOp[]) {
        const before = await openProject(this.recording);
        const edited = await editProject(this.recording, ops);
        this.history.push(before.project);
        return describeProject(edited.project, edited.path);
    }

    split(at: z.infer<typeof timeSchema>) {
        return this.change([{ op: "split", at }]);
    }

    cut(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "cut", from, to }]);
    }

    keep(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "keep", from, to }]);
    }

    speed(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>, factor: number) {
        return this.change([{ op: "speed", from, to, factor }]);
    }

    zoom(options: z.infer<typeof zoomSchema>) {
        return this.change([{ op: "zoom", ...options }]);
    }

    unzoom(id: string) {
        return this.change([{ op: "unzoom", id }]);
    }

    autoZoom(options: { scale?: number } = {}) {
        return this.change([{ op: "autoZoom", ...options }]);
    }

    volume(volume: number) {
        return this.change([{ op: "volume", volume }]);
    }

    mute(track: number) {
        return this.change([{ op: "mute", track, muted: true }]);
    }

    unmute(track: number) {
        return this.change([{ op: "mute", track, muted: false }]);
    }

    apply(ops: EditOp[]) {
        return this.change(ops);
    }

    reset() {
        return this.change([{ op: "reset" }]);
    }

    async undo() {
        const previous = this.history.pop();

        if (!previous) {
            throw new Error("nothing to undo: this handle made no change yet");
        }

        const opened = await openProject(this.recording);
        const saved = writeProject(opened.path, { ...previous, revision: opened.project.revision });
        return describeProject(saved, opened.path);
    }

    async export(options: { out?: string } = {}) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        await ensureRecorderPart();
        const answer = await exportEdit(opened.path, options.out);

        if (!answer.ok || !answer.path) {
            throw new Error(answer.error ?? "the export failed without a reason");
        }

        const info = await probeVideo({ input: answer.path });
        return {
            path: answer.path,
            bytes: answer.bytes,
            outputSeconds: Math.round(info.durationUs / 1000) / 1000,
            width: info.width,
            height: info.height,
            renderSeconds: answer.seconds,
        };
    }

    async show(options: { focus?: boolean } = {}) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        await ensureRecorderPart();
        openEditor(opened.path, { focus: options.focus === true });
        return { opened: opened.path };
    }
}

export class MovieRecording {
    constructor(readonly entry: LiveEntry) {}

    get id(): string {
        return this.entry.id;
    }

    get folder(): string | undefined {
        return this.entry.folder;
    }

    status() {
        return callRecorder({ id: this.id, method: "status" });
    }

    pause() {
        return callRecorder({ id: this.id, method: "pause" });
    }

    resume() {
        return callRecorder({ id: this.id, method: "resume" });
    }

    /** Stops, then waits until the recorder wrote the final manifest, so the movie is complete. */
    async stop(): Promise<Movie> {
        const folder = this.folder;

        if (!folder) {
            throw new Error(`the recording ${this.id} names no folder`);
        }

        if (listLiveRecordings().some((entry) => entry.id === this.id)) {
            await callRecorder({ id: this.id, method: "stop", params: { wait: true } });
        }

        const deadline = Date.now() + FINISH_TIMEOUT_MS;

        while (!readRecordingManifest(folder)?.endedAt) {
            if (Date.now() > deadline) {
                throw new Error(`the recording stopped but ${folder} has no finished manifest after 120 s`);
            }

            await Bun.sleep(POLL_MS);
        }

        return new Movie(folder);
    }
}

/** Starts `tools recorder start` in its own process (a REPL reset must not end a recording) and waits for its entry. */
async function record(options: z.infer<typeof recordSchema>): Promise<MovieRecording> {
    const before = new Set(listLiveRecordings().map((entry) => entry.id));
    const args = ["recorder", "start"];

    if (options.audio?.length) {
        args.push("--audio", options.audio.join(","));
    }

    if (options.title) {
        args.push("--title", options.title);
    }

    if (options.maxSeconds !== undefined) {
        args.push("--max-seconds", String(options.maxSeconds));
    }

    if (options.display !== undefined) {
        args.push("--display", String(options.display));
    }

    if (options.app) {
        args.push("--app", options.app);
    }

    if (options.window?.length) {
        args.push("--window", options.window.join(","));
    }

    if (options.fps !== undefined) {
        args.push("--fps", String(options.fps));
    }

    if (options.controls === false) {
        args.push("--no-controls");
    }

    if (options.indicator === false) {
        args.push("--no-indicator");
    }

    log.info({ args }, "movie recording requested");
    spawnToolDetached(args, { reparent: true });
    const deadline = Date.now() + START_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const started = listLiveRecordings().find(
            (entry) => !before.has(entry.id) && entry.folder?.includes("/video-") && entry.state === "recording"
        );

        if (started) {
            return new MovieRecording(started);
        }

        await Bun.sleep(POLL_MS);
    }

    throw new Error(
        `the recording did not start within ${START_TIMEOUT_MS / 1000} s; run \`tools genesis-tools logs failures\` or \`tools recorder start\` in a terminal to see why`
    );
}

export class MoviesToolset extends ReplToolset {
    readonly api = moviesApi;

    async bootstrap(): Promise<Record<string, unknown>> {
        return {
            movies: {
                list: (options: { limit?: number } = {}) => listLibrary().slice(0, options.limit ?? 20),
                open: (recording: string) => new Movie(recording),
                record: (options: z.infer<typeof recordSchema> = {}) => record(options),
            },
        };
    }
}
