import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { execTool, spawnToolDetached } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { timeSchema, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import {
    CANVAS_ASPECTS,
    describeProject,
    type EditOp,
    type EditProject,
    editOpSchema,
    findInTranscript,
    hexColor,
    outputDurationUs,
    REDACTION_STYLES,
    shortcutsOf,
    type TranscriptLine,
    transcriptCachePath,
    transcriptLines,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { callRecorder, type LiveEntry, listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { z } from "zod";
import { EXPORT_FORMATS, type ExportFormat, editProject, exportAs, openProject } from "./edit";
import { ensureRecorderPart, listLibrary, openEditor, stillOfEdit } from "./library";

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

const movieDoc =
    "{ path, revision, updatedBy, video, sourceSeconds, outputSeconds, clips, zooms, redactions, audio, export, clicks, frame, cursor, captions, keys }";
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
        "redact",
        z
            .object({
                from: timeSchema,
                to: timeSchema,
                rect: z
                    .object({
                        x: z.number().min(0).max(1),
                        y: z.number().min(0).max(1),
                        width: z.number().min(0.005).max(1),
                        height: z.number().min(0.005).max(1),
                    })
                    .strict(),
                style: z.enum(REDACTION_STYLES).optional(),
            })
            .strict(),
        'Hides a rectangle of the SOURCE picture from `from` to `to` (source seconds or "m:ss"): rect { x, y, width, height } as 0...1 of the picture from its top left, style "blur" (default) | "pixelate" | "black". It moves with a zoom. The result lists redactions with their ids.'
    ),
    edit("unredact", z.object({ id: z.string() }), "Removes a redaction by its id.", ["id"]),
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
    edit(
        "clicks",
        z
            .object({
                highlight: z.boolean().optional(),
                color: hexColor.optional(),
                radius: z.number().min(0.005).max(0.2).optional(),
                durationMs: z.number().int().min(100).max(3000).optional(),
            })
            .strict(),
        'Draws each recorded click as a disc that grows and fades: highlight, color "#RRGGBB", radius (a fraction of the height, 0.03), durationMs (450).'
    ),
    edit(
        "keys",
        z
            .object({
                show: z.boolean().optional(),
                size: z.number().min(0.02).max(0.12).optional(),
                position: z.enum(["bottom", "top"]).optional(),
                durationMs: z.number().int().min(300).max(5000).optional(),
            })
            .strict(),
        'Draws the ⌘/⌃ shortcuts the recording kept as they were pressed: show, size (0.05 of the short side), position "bottom" | "top", durationMs (1200). Throws when the recording kept none.'
    ),
    edit(
        "captions",
        z
            .object({
                show: z.boolean().optional(),
                size: z.number().min(0.02).max(0.1).optional(),
                position: z.enum(["bottom", "top"]).optional(),
            })
            .strict(),
        'Draws the spoken lines over the picture from the cached transcript (call transcript() first): show, size (text height, a fraction of the short side, 0.038), position "bottom" | "top". Captions follow every cut.'
    ),
    edit(
        "cursor",
        z
            .object({
                show: z.boolean().optional(),
                size: z.number().min(0.5).max(3).optional(),
                smoothing: z.number().min(0).max(1).optional(),
                hideAfterMs: z.number().int().min(0).max(30_000).optional(),
            })
            .strict(),
        "The cursor the editor draws (a movie recorded without the system cursor; info() shows cursor: null otherwise): show, size (times the recorded size, 1), smoothing (0 raw path, 1 smoothest, 0.5), hideAfterMs (fade out after standing still this long, 0 never). It still sits on every click."
    ),
    edit(
        "frame",
        z
            .object({
                enabled: z.boolean().optional(),
                aspect: z.enum(CANVAS_ASPECTS).optional(),
                fit: z.enum(["contain", "cover"]).optional(),
                background: z
                    .object({
                        kind: z.enum(["none", "color", "gradient"]).optional(),
                        colors: z.array(hexColor).min(1).max(2).optional(),
                    })
                    .strict()
                    .optional(),
                padding: z.number().min(0).max(0.3).optional(),
                cornerRadius: z.number().min(0).max(0.1).optional(),
                shadow: z.boolean().optional(),
            })
            .strict(),
        'Puts the movie on a background: aspect (the canvas: "16:9", "4:3", "1:1", "9:16" or "source"; its short side is the movie height), fit ("contain" the whole movie, or "cover": cropped to fill the room inside the padding, following the cursor; padding 0 for edge to edge), padding (0.06 of the short side), cornerRadius (0.012), shadow, background { kind: "gradient" | "color" | "none", colors }; enabled: false removes it.'
    ),
    edit(
        "removeIdle",
        z
            .object({
                minSeconds: z.number().min(0.5).max(600).optional(),
                keepSeconds: z.number().min(0).max(5).optional(),
            })
            .strict(),
        "Cuts every stretch where the picture does not change AND nothing is heard for minSeconds (default 2), keeping keepSeconds (0.3) at each end; a still picture under speech stays. The result adds removed: [[from, to], …] in source seconds."
    ),
    edit(
        "normalize",
        z.object({ targetLufs: z.number().min(-30).max(-8).optional() }).strict(),
        "Measures the movie's loudness (EBU R128, the unmuted tracks mixed) and sets the volume so the export reaches targetLufs (default -16, speech on the web; -14 music). The volume tops out at 200 % (+6 dB). The result adds loudness: { measuredLufs, volume }."
    ),
    defineMethod({
        name: "export",
        params: z.object({ out: z.string().optional(), format: z.enum(EXPORT_FORMATS).optional() }).strict(),
        result: z.unknown(),
        resultName: "{ path, bytes, outputSeconds, width, height, renderSeconds }",
        doc: 'Renders the edit with the editor\'s renderer to format "mp4" (default), "gif" (10 fps, at most 960 wide) or "webm"; throws when the file exists (it never overwrites).',
        effect: "reversible",
    }),
    defineMethod({
        name: "transcript",
        params: z
            .object({ provider: z.string().optional(), lang: z.string().optional(), refresh: z.boolean().optional() })
            .strict(),
        result: z.unknown(),
        resultName: "{ from, to, plays, text }[]",
        doc: "The spoken lines in source seconds (plays: where each starts in the edit, null when cut), from tools transcribe; cached beside the movie, refresh: true transcribes again. The first run may ask for the AI vault key.",
        effect: "read",
    }),
    defineMethod({
        name: "still",
        params: z.object({ at: timeSchema.optional() }),
        positional: ["at"],
        result: z.unknown(),
        resultName: "{ path, width, height }",
        doc: "Shows one frame of the edit as it exports (zoom, clicks, cursor, captions, shortcuts, frame style) at OUTPUT seconds (what plays), so you can look at a change. It renders at preview size (the movie at most 1080 high); export() uses the export size.",
        effect: "read",
    }),
    defineMethod({
        name: "find",
        params: z.object({ text: z.string().min(1) }),
        positional: ["text"],
        result: z.unknown(),
        resultName: "{ from, to, plays, text }[]",
        doc: "The transcript lines that hold the text (case and accents ignored); cut one with cut(line.from, line.to).",
        effect: "read",
    }),
    defineMethod({
        name: "shortcuts",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ at, plays, key }[]",
        doc: 'The ⌘/⌃ shortcuts the recording kept ("⌘C"), at source seconds, plays: where each shows in the edit (null when cut). keys() draws them.',
        effect: "read",
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

    /** `ctx`: the worker's scratch folder and `show`, for still(); absent outside a REPL. */
    constructor(
        readonly recording: string,
        private readonly ctx?: ToolsetContext
    ) {}

    async info() {
        const opened = await openProject(this.recording);
        return describeProject(opened.project, opened.path);
    }

    private async change(ops: EditOp[]) {
        const before = await openProject(this.recording);
        const edited = await editProject(this.recording, ops);
        this.history.push(before.project);
        const described = describeProject(edited.project, edited.path);
        const seconds = (us: number) => Math.round(us / 1000) / 1000;
        return {
            ...described,
            ...(edited.removedIdleUs
                ? { removed: edited.removedIdleUs.map(([from, to]) => [seconds(from), seconds(to)]) }
                : {}),
            ...(edited.loudness ? { loudness: edited.loudness } : {}),
        };
    }

    async split(at: z.infer<typeof timeSchema>) {
        return this.change([{ op: "split", at }]);
    }

    async cut(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "cut", from, to }]);
    }

    async keep(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>) {
        return this.change([{ op: "keep", from, to }]);
    }

    async speed(from: z.infer<typeof timeSchema>, to: z.infer<typeof timeSchema>, factor: number) {
        return this.change([{ op: "speed", from, to, factor }]);
    }

    async zoom(options: z.infer<typeof zoomSchema>) {
        return this.change([{ op: "zoom", ...options }]);
    }

    async unzoom(id: string) {
        return this.change([{ op: "unzoom", id }]);
    }

    async redact(options: Omit<Extract<EditOp, { op: "redact" }>, "op">) {
        return this.change([{ op: "redact", ...options }]);
    }

    async unredact(id: string) {
        return this.change([{ op: "unredact", id }]);
    }

    async autoZoom(options: { scale?: number } = {}) {
        return this.change([{ op: "autoZoom", ...options }]);
    }

    async volume(volume: number) {
        return this.change([{ op: "volume", volume }]);
    }

    async mute(track: number) {
        return this.change([{ op: "mute", track, muted: true }]);
    }

    async unmute(track: number) {
        return this.change([{ op: "mute", track, muted: false }]);
    }

    async apply(ops: EditOp[]) {
        return this.change(ops);
    }

    async reset() {
        return this.change([{ op: "reset" }]);
    }

    async clicks(options: Omit<Extract<EditOp, { op: "clicks" }>, "op"> = {}) {
        return this.change([{ op: "clicks", ...options }]);
    }

    async keys(options: Omit<Extract<EditOp, { op: "keys" }>, "op"> = {}) {
        return this.change([{ op: "keys", ...options }]);
    }

    async captions(options: Omit<Extract<EditOp, { op: "captions" }>, "op"> = {}) {
        return this.change([{ op: "captions", ...options }]);
    }

    async cursor(options: Omit<Extract<EditOp, { op: "cursor" }>, "op"> = {}) {
        return this.change([{ op: "cursor", ...options }]);
    }

    async frame(options: Omit<Extract<EditOp, { op: "frame" }>, "op"> = {}) {
        return this.change([{ op: "frame", ...options }]);
    }

    async removeIdle(options: { minSeconds?: number; keepSeconds?: number } = {}) {
        return this.change([
            { op: "removeIdle", minSeconds: options.minSeconds ?? 2, keepSeconds: options.keepSeconds ?? 0.3 },
        ]);
    }

    async normalize(options: { targetLufs?: number } = {}) {
        return this.change([{ op: "normalize", targetLufs: options.targetLufs ?? -16 }]);
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

    async export(options: { out?: string; format?: ExportFormat } = {}) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        await ensureRecorderPart();
        const answer = await exportAs(opened.path, options);

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

    /** `<movie>.transcript.json` beside the movie: the raw result, so a later edit maps it again for free. */
    async transcript(options: { provider?: string; lang?: string; refresh?: boolean } = {}): Promise<TranscriptLine[]> {
        const opened = await openProject(this.recording);
        const video = opened.project.source.video;
        const cache = transcriptCachePath(video);

        if (!options.refresh && existsSync(cache)) {
            return transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), opened.project);
        }

        const args = ["transcribe", video, "--format", "json", "-o", cache];

        if (options.provider) {
            args.push("--provider", options.provider);
        }

        if (options.lang) {
            args.push("--lang", options.lang);
        }

        log.info({ video, provider: options.provider ?? "default", cache }, "transcribing the movie");
        const result = await execTool(args, { timeout: 60 * 60_000 });

        if (!result.success || !existsSync(cache)) {
            const reason = result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${result.exitCode}`;
            throw new Error(`the transcription failed: ${reason}`);
        }

        return transcriptLines(SafeJSON.parse(readFileSync(cache, "utf8"), { strict: true }), opened.project);
    }

    /** One frame of the edit as it exports, shown to the model; `at` is OUTPUT seconds (what plays). */
    async still(at: z.infer<typeof timeSchema> = 0) {
        const opened = await openProject(this.recording);

        if (opened.fresh) {
            writeProject(opened.path, opened.project);
        }

        const atUs = timeToUs(at);
        const lengthUs = outputDurationUs(opened.project);

        if (atUs > lengthUs) {
            throw new Error(
                `at (${atUs / 1_000_000} s) is after the end of the edit (${Math.round(lengthUs / 1000) / 1000} s); still() takes OUTPUT seconds, 0 to the edit's length`
            );
        }

        await ensureRecorderPart();
        const out = join(this.ctx?.scratchDir ?? tmpdir(), `still-${Date.now()}.png`);
        const answer = await stillOfEdit({ path: opened.path, atSeconds: atUs / 1_000_000, out });

        if (!answer.ok || !answer.path) {
            throw new Error(answer.error ?? "the still failed without a reason");
        }

        await this.ctx?.show({ path: answer.path });
        return { path: answer.path, width: answer.width, height: answer.height };
    }

    async find(text: string): Promise<TranscriptLine[]> {
        return findInTranscript(await this.transcript(), text);
    }

    async shortcuts() {
        return shortcutsOf((await openProject(this.recording)).project);
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
    constructor(
        readonly entry: LiveEntry,
        private readonly ctx?: ToolsetContext
    ) {}

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

        return new Movie(folder, this.ctx);
    }
}

/** Starts `tools recorder start` in its own process (a REPL reset must not end a recording) and waits for its entry. */
async function record(options: z.infer<typeof recordSchema>, ctx?: ToolsetContext): Promise<MovieRecording> {
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
            return new MovieRecording(started, ctx);
        }

        await Bun.sleep(POLL_MS);
    }

    throw new Error(
        `the recording did not start within ${START_TIMEOUT_MS / 1000} s; run \`tools genesis-tools logs failures\` or \`tools recorder start\` in a terminal to see why`
    );
}

export class MoviesToolset extends ReplToolset {
    readonly api = moviesApi;

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        return {
            movies: {
                list: (options: { limit?: number } = {}) => listLibrary().slice(0, options.limit ?? 20),
                open: (recording: string) => new Movie(recording, ctx),
                record: (options: z.infer<typeof recordSchema> = {}) => record(options, ctx),
            },
        };
    }
}
