import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { appStatus, buildApp } from "@app/macos/lib/permissions/app";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { readRecordingManifest, recordingsLibraryDir } from "@genesiscz/utils/screen-recorder/library";
import { recordingStores } from "@genesiscz/utils/screen-recorder/recording-stores";
import { z } from "zod";

const { log } = logger.scoped("recorder-library");

/** What a recorder writes into a manifest's `settings` when its recording ends: the outcome and the movie's length. */
const recordingEndSchema = z.object({
    outcome: z.string().optional(),
    video: z.object({ durationMs: z.number().optional() }).optional(),
});

/** A library id with its whole uuid: `video-2026-11-06_20-50-38-0eb8dd5f-7cec-4561-9379-63bc9cbfa33b`. */
const LONG_RECORDING_ID =
    /^([a-z]+-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id a table shows: the stamp and the uuid's first block. Every command takes it (`resolveRecording`). */
export function shortRecordingId(id: string): string {
    return LONG_RECORDING_ID.exec(id)?.[1] ?? id;
}

/**
 * The movie a recording folder holds, in the order the editor looks for one: the recorder's movie, then the proxy
 * `tools recorder proxy` makes of a frames recording. The Swift app's RecordingMovie keeps the same list; both run
 * src/utils/recording-editor/__fixtures__/recording-movies.json.
 */
export const RECORDING_MOVIES = ["screen.mp4", "screen.mov", "proxy.mp4"] as const;

/** The camera's movie beside `screen.mp4`, written by the recorder face when the recording asked for the camera. */
export const CAMERA_MOVIE = "camera.mov";

/** The movies of a recording folder that are the recording itself, so never an export of it. */
export const RECORDING_SOURCE_MOVIES: ReadonlySet<string> = new Set([...RECORDING_MOVIES, CAMERA_MOVIE]);

export interface LibraryRow {
    id: string;
    title: string;
    folder: string;
    startedAt: string;
    endedAt?: string;
    /** The movie the editor opens, when the recording has one. */
    movie?: string;
    frames: number;
    /** `edit.json` exists: the recording was edited. */
    edited: boolean;
    /** How the recording ended (`done`, `failed`, `discarded`), when its recorder wrote it. */
    outcome?: string;
    /** The movie's length, when the recorder wrote it. */
    durationMs?: number;
    /** Why a failed recording made no movie: its first warning. */
    reason?: string;
}

export function movieOf(folder: string): string | undefined {
    return RECORDING_MOVIES.map((name) => join(folder, name)).find((path) => existsSync(path));
}

/**
 * Pause on a paused recording and resume on a running one have nothing to do: an agent that repeats them gets this
 * answer and exit 0, not "the recording is paused" and exit 1. Undefined when the call has work to do.
 */
export function alreadyInState(
    method: "stop" | "pause" | "resume" | "status",
    state: string | undefined
): string | undefined {
    if (method === "pause" && state === "paused") {
        return "already paused";
    }

    if (method === "resume" && state === "recording") {
        return "already recording";
    }

    return undefined;
}

/** Why a marker label is refused, as the live recording's own rule has it (1 to 80 characters after trimming). */
export function markerLabelProblem(label: string): string | undefined {
    const length = label.trim().length;
    return length >= 1 && length <= 80 ? undefined : "A marker label is 1 to 80 characters.";
}

/** What a live recording is for an agent: its live id (stop, mark), its library id and folder, after a stop its movie. */
export interface LiveRecordingRef {
    liveId: string;
    id?: string;
    folder?: string;
    movie?: string;
}

export function liveRecordingRef(
    entry: { id: string; folder?: string },
    { stopped = false }: { stopped?: boolean } = {}
): LiveRecordingRef {
    if (!entry.folder) {
        return { liveId: entry.id };
    }

    const movie = stopped ? movieOf(entry.folder) : undefined;
    return { liveId: entry.id, id: basename(entry.folder), folder: entry.folder, ...(movie ? { movie } : {}) };
}

/** Every library recording, newest first. */
export function listLibrary(options: string | { root?: string; limit?: number } = {}): LibraryRow[] {
    const { root = recordingsLibraryDir(), limit = Infinity } =
        typeof options === "string" ? { root: options } : options;
    if (!existsSync(root)) {
        return [];
    }

    const rows: LibraryRow[] = [];

    const folders = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const match = /^(?:library|video)-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(entry.name);
            const time = match
                ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`).getTime()
                : statSync(join(root, entry.name)).birthtimeMs;
            return { name: entry.name, time };
        })
        .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));

    for (const { name } of folders) {
        if (rows.length >= Math.max(0, limit)) {
            break;
        }
        const folder = join(root, name);
        const manifest = readRecordingManifest(folder);

        if (!manifest) {
            continue;
        }

        const end = recordingEndSchema.safeParse(manifest.settings).data ?? {};
        rows.push({
            id: manifest.id,
            title: manifest.title,
            folder,
            startedAt: manifest.startedAt,
            endedAt: manifest.endedAt,
            movie: movieOf(folder),
            frames: manifest.frames.length,
            edited: existsSync(join(folder, "edit.json")),
            ...(end.outcome ? { outcome: end.outcome } : {}),
            ...(end.video?.durationMs === undefined ? {} : { durationMs: end.video.durationMs }),
            ...(end.outcome === "failed" && manifest.warnings[0] ? { reason: manifest.warnings[0] } : {}),
        });
    }

    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * What a recording argument names: a library id (`library-…`), `last` (the newest), a meeting id (its folder), or a
 * path to a movie, a recording folder or an edit file. Throws with the ids it knows when nothing matches.
 */
/**
 * The recording an edit file names before anything wrote it (projectPathFor): a recording folder's `edit.json`, or
 * `<name>.edit.json` beside a plain movie. The editor holds that path from its first open, so the service's
 * session.open gets it for a recording that was never edited.
 */
function recordingOfUnwrittenEdit(path: string): string | undefined {
    const folder = dirname(path);
    const file = basename(path);

    if (file === "edit.json") {
        return existsSync(join(folder, "recording.json")) ? folder : undefined;
    }

    if (!file.endsWith(".edit.json") || !existsSync(folder)) {
        return undefined;
    }

    const name = file.slice(0, -".edit.json".length);
    const movie = readdirSync(folder).find(
        (entry) => !entry.endsWith(".json") && basename(entry, extname(entry)) === name
    );
    return movie ? join(folder, movie) : undefined;
}

export function resolveRecording(value: string, { alive }: { alive?: (pid: number) => boolean } = {}): string {
    if (value === "open") {
        const state = readEditorOpenState({ alive });
        // The window last in front; with one window open, that one even if it never came to the front.
        const front = state?.front ?? (state?.open.length === 1 ? state.open[0] : undefined);

        if (!front) {
            throw new Error(
                "No recording is open in the editor. Pick one with " +
                    toolCommand("recorder library") +
                    ", or name one (`last`, an id)."
            );
        }

        return front.path;
    }

    if (value === "last") {
        const newest = listLibrary({ limit: 1 })[0];

        if (!newest) {
            throw new Error("The recordings library is empty; record one with " + toolCommand("recorder start") + ".");
        }

        return newest.folder;
    }

    const path = resolve(value);

    if (existsSync(path)) {
        return path;
    }

    const unwritten = recordingOfUnwrittenEdit(path);

    if (unwritten) {
        return unwritten;
    }

    // A store's id, the library first; a meeting's folder holds its frames (and, once the editor opened it,
    // recording.json).
    for (const store of recordingStores()) {
        const folder = store.folderOf(value);

        if (existsSync(store.framesOf(value)) && statSync(folder).isDirectory()) {
            return folder;
        }
    }

    // A short id, as `tools recorder list` shows it: the one library folder whose name starts with it.
    const library = recordingsLibraryDir();
    const matches =
        value.length >= 12 && existsSync(library) ? readdirSync(library).filter((name) => name.startsWith(value)) : [];

    if (matches.length === 1) {
        return join(library, matches[0]);
    }

    if (matches.length > 1) {
        throw new Error(
            `${matches.length} recordings start with "${value}": ${matches.join(", ")}. Give more of the id.`
        );
    }

    const known = listLibrary({ limit: 5 }).map((row) => row.id);
    throw new Error(
        `No recording "${value}": not a path and not a library id. Newest ids: ${known.join(", ") || "none"} (or "last").`
    );
}

/** Builds the app with the recorder part when the installed one lacks it. */
export async function ensureRecorderPart(onStep?: (line: string) => void): Promise<void> {
    const status = appStatus();

    if (status.built && status.parts.includes("recorder")) {
        return;
    }

    onStep?.("GenesisTools.app has no recorder part yet: building it (about a minute)");
    log.info({ parts: status.parts }, "recorder: adding the recorder part");
    await buildApp({ onStep, parts: { add: ["recorder"] } });
}

/** One editor window: its recording folder, title and (from a build with the recorder host) its window number. */
const editorWindowSchema = z.object({ path: z.string(), title: z.string(), window: z.number().int().optional() });
const editorOpenSchema = z.object({
    version: z.literal(1),
    pid: z.number().int().optional(),
    updatedAt: z.string(),
    front: editorWindowSchema.optional(),
    open: z.array(editorWindowSchema),
});

export type EditorOpenState = z.infer<typeof editorOpenSchema>;
export type EditorWindowRow = z.infer<typeof editorWindowSchema>;

/** The file the editor rewrites whenever a window opens, comes to the front or closes. */
export function editorOpenStatePath(): string {
    return join(dirname(recordingsLibraryDir()), "editor-open.json");
}

/** The editor that wrote the file: alive and still a GenesisTools process, not a recycled pid. */
function editorAlive(pid: number): boolean {
    return classifyPid(pid, (command) => command.includes("GenesisTools")).status === "live";
}

/** Which recordings the editor shows and which one is in front; null when no editor ran since the app was built. */
export function readEditorOpenState({
    alive = editorAlive,
}: {
    alive?: (pid: number) => boolean;
} = {}): EditorOpenState | null {
    const path = editorOpenStatePath();

    if (!existsSync(path)) {
        return null;
    }

    const parsed = editorOpenSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8")));

    if (!parsed.success) {
        log.warn({ path, issues: parsed.error.issues }, "recorder: editor-open.json has an unknown shape");
        return null;
    }

    // The editor that wrote it is gone (a crash, a rebuild's reap): its windows are closed whatever the file says.
    if (parsed.data.pid !== undefined && !alive(parsed.data.pid)) {
        log.debug({ path, pid: parsed.data.pid }, "recorder: editor-open.json is from a process that is gone");
        return { ...parsed.data, front: undefined, open: [] };
    }

    return parsed.data;
}

/**
 * Waits until the editor brings a recording to the front after this call (a pick in the library, a double-click, a
 * click on another editor window), and returns it. Throws when `timeoutMs` passes first.
 */
export async function waitForEditorOpen({ timeoutMs }: { timeoutMs: number }): Promise<EditorWindowRow> {
    const startedAt = readEditorOpenState()?.updatedAt ?? "";
    const deadline = Date.now() + timeoutMs;
    log.debug({ path: editorOpenStatePath(), timeoutMs }, "recorder: wait for the editor to open a recording");

    while (Date.now() < deadline) {
        const state = readEditorOpenState();

        if (state?.front && state.updatedAt > startedAt) {
            log.debug({ front: state.front }, "recorder: the editor opened a recording");
            return state.front;
        }

        await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }

    throw new Error(`No recording came to the front in the editor within ${Math.round(timeoutMs / 1000)} s.`);
}

/** Runs `open` with these arguments; throws with its message when it fails. */
export function openWithApp(args: string[]): void {
    log.debug({ args }, "recorder: open the app");
    const result = spawnSync("open", args, { encoding: "utf8" });

    if (result.status !== 0) {
        throw new Error(`open failed (${result.status}): ${(result.stderr || result.error?.message || "").trim()}`);
    }
}

/** The `open` arguments of a recorder window: a new process that hands them to the running recorder face. */
function recorderOpenArgs(focus: boolean, faceArgs: string[]): string[] {
    return [
        "-n",
        ...(focus ? [] : ["-g"]),
        genesisAppBundlePath(),
        "--args",
        "--recorder",
        ...faceArgs,
        ...(focus ? [] : ["--no-focus"]),
    ];
}

/** The `open` arguments of the library window, or of the capture picker. */
export function recorderWindowArgs(which: "library" | "picker", { focus = true }: { focus?: boolean } = {}): string[] {
    return recorderOpenArgs(focus, [which === "library" ? "--library" : "--picker"]);
}

/**
 * The `open` arguments that start the recorder face in the background with no window (its menu and services). `-n`:
 * a new process, as for the windows; without it Launch Services hands the request to a running face (the hub), whose
 * main never sees `--recorder`. When a recorder face runs already, the new process forwards its arguments to it and
 * exits (`SingleInstance` in RecorderFace.swift).
 */
export function recorderFaceArgs(): string[] {
    return ["-n", "-g", genesisAppBundlePath(), "--args", "--recorder"];
}

/** Opens the recordings library window, where a double-click opens a recording in the editor. */
export function openLibraryWindow({ focus = true }: { focus?: boolean } = {}): void {
    openWithApp(recorderWindowArgs("library", { focus }));
}

/** Opens the editor through Launch Services; a running recorder takes the request. */
/**
 * The editor window's inspector tabs, as `--tab` takes them: the Swift `InspectorTab` cases, in the same order
 * (service.test.ts reads the Swift enum and fails when the two lists differ).
 */
export const EDITOR_TABS = [
    "zoom",
    "clip",
    "hide",
    "text",
    "style",
    "cursor",
    "captions",
    "audio",
    "export",
    "find",
] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export interface EditorPlace {
    focus?: boolean;
    atSeconds?: number;
    tab?: EditorTab;
}

/** The `open` arguments of the editor window on `path`. */
export function editorOpenArgs(path: string, { focus = true, atSeconds, tab }: EditorPlace = {}): string[] {
    return recorderOpenArgs(focus, [
        "--edit",
        path,
        ...(atSeconds !== undefined ? ["--at", String(atSeconds)] : []),
        ...(tab ? ["--tab", tab] : []),
    ]);
}

/** Opens the editor window on `path`; `atSeconds` (output time) and `tab` place it at a moment and a panel. */
export function openEditor(path: string, place: EditorPlace = {}): void {
    openWithApp(editorOpenArgs(path, place));
}

export const stillAnswerSchema = z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    error: z.string().optional(),
});
export type StillAnswer = z.infer<typeof stillAnswerSchema>;

export const exportAnswerSchema = z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    bytes: z.number().optional(),
    seconds: z.number().optional(),
    error: z.string().optional(),
});
export type ExportAnswer = z.infer<typeof exportAnswerSchema>;

/** What one headless run of the recorder face printed, and how it exited. */
export interface FaceRun {
    code: number;
    stdout: string;
    stderr: string;
}

/** Runs the app's recorder face headless (`--export`, `--still`, `--snapshot`); `signal` ends the run. */
export async function runFaceProcess(argv: string[], signal?: AbortSignal): Promise<FaceRun> {
    const binary = join(genesisAppBundlePath(), "Contents/MacOS/GenesisTools");
    log.debug({ binary, argv }, "recorder: headless face run");
    const child = spawn(binary, argv, { stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    child.on("error", (error) => {
        log.debug({ error, argv }, "recorder: the face run ended with an error");
    });
    const code = await new Promise<number>((done) => {
        const timer = setTimeout(
            () => {
                stderr += "headless renderer exceeded its deadline";
                child.kill("SIGKILL");
                child.stdout.destroy();
                child.stderr.destroy();
                done(1);
            },
            argv.includes("--export") ? 60 * 60_000 : 120_000
        );
        child.once("close", (status) => {
            clearTimeout(timer);
            done(status ?? 1);
        });
        child.once("error", () => {
            clearTimeout(timer);
            child.kill("SIGKILL");
            child.stdout.destroy();
            child.stderr.destroy();
            done(1);
        });
    });
    return { code, stdout, stderr };
}

/** The one JSON line a face run printed last; an exit without one becomes `{ ok: false }` with the end of its output. */
export function faceAnswer<T extends { ok: boolean; error?: string }>(
    run: FaceRun,
    schema: z.ZodType<T>,
    what: string
): T | { ok: false; error: string } {
    const line = run.stdout.trim().split("\n").at(-1) ?? "";
    const parsed = schema.safeParse(parseOrUndefined(line));

    if (parsed.success) {
        log.debug({ code: run.code, answer: parsed.data }, `recorder: ${what} finished`);
        return parsed.data;
    }

    log.warn({ code: run.code, stdout: run.stdout, stderr: run.stderr }, `recorder: ${what} printed no answer`);
    return { ok: false, error: `the ${what} exited ${run.code}: ${(run.stderr || run.stdout).trim().slice(-400)}` };
}

/** Runs a headless step of the app's recorder face and reads the one JSON line it prints last. */
async function runRecorderFace<T extends { ok: boolean; error?: string }>({
    argv,
    schema,
    what,
}: {
    argv: string[];
    schema: z.ZodType<T>;
    what: string;
}): Promise<T | { ok: false; error: string }> {
    return faceAnswer(await runFaceProcess(argv), schema, what);
}

function parseOrUndefined(line: string): unknown {
    try {
        return SafeJSON.parse(line, { strict: true });
    } catch (error) {
        log.debug({ error, line }, "recorder: not a JSON line");
        return undefined;
    }
}

export interface StillRequest {
    path: string;
    atSeconds: number;
    /** Absent: a temporary file the face names in its answer. */
    out?: string;
    /** The export's size (a poster frame) instead of the 1080 pixel preview. */
    full?: boolean;
}

export function stillArgv({ path, atSeconds, out, full = false }: StillRequest): string[] {
    return [
        "--recorder",
        "--still",
        path,
        "--at",
        String(atSeconds),
        ...(out ? ["--out", resolve(out)] : []),
        ...(full ? ["--full"] : []),
    ];
}

/** One frame of the edit as it exports (zoom, clicks, frame style), from a headless run of the recorder face. */
export function stillOfEdit(request: StillRequest) {
    return runRecorderFace({ argv: stillArgv(request), schema: stillAnswerSchema, what: "still" });
}

export const sheetAnswerSchema = z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    times: z.array(z.number()).optional(),
    error: z.string().optional(),
});
export type SheetAnswer = z.infer<typeof sheetAnswerSchema>;

export function sheetArgv({ path, times, out }: { path: string; times: number[]; out?: string }): string[] {
    return ["--recorder", "--sheet", path, "--times", times.join(","), ...(out ? ["--out", resolve(out)] : [])];
}

/** Several frames of an edit (OUTPUT seconds) on one picture in rows of three, each labelled with its time. */
export function sheetOfEdit(request: { path: string; times: number[]; out: string }) {
    return runRecorderFace({ argv: sheetArgv(request), schema: sheetAnswerSchema, what: "sheet" });
}

export function exportArgv(path: string, out?: string): string[] {
    return ["--recorder", "--export", path, "--json", ...(out ? ["--out", resolve(out)] : [])];
}

/**
 * Renders an edit with the editor's own renderer (AVFoundation, hardware encoder) in a headless run of the app's
 * recorder face, so an agent's export is the movie the window would export.
 */
export function exportEdit(path: string, out?: string): Promise<ExportAnswer> {
    return runRecorderFace({ argv: exportArgv(path, out), schema: exportAnswerSchema, what: "export" });
}

/** A picture of a recorder window as it would look (`--snapshot`): an edit's editor, the library or the picker. */
export interface SnapshotRequest {
    out: string;
    /** The edit whose editor window is drawn; absent with `library` or `picker`. */
    path?: string;
    library?: boolean;
    picker?: boolean;
    width?: number;
    height?: number;
    atSeconds?: number;
    tab?: EditorTab;
    selectZoom?: number;
    selectClip?: number;
    part?: { from: number; to: number };
    range?: { from: number; to: number };
    comment?: number;
    /** The library's search text. */
    filter?: string;
    /** The picker with its Shortcuts section open. */
    shortcuts?: boolean;
}

export function snapshotArgv(request: SnapshotRequest): string[] {
    const pair = (flag: string, value: number | string | undefined) =>
        value === undefined ? [] : [flag, String(value)];
    const span = (flag: string, value: { from: number; to: number } | undefined) =>
        value ? [flag, `${value.from}-${value.to}`] : [];
    return [
        "--recorder",
        ...(request.path ? ["--edit", request.path] : []),
        ...(request.library ? ["--library"] : []),
        ...(request.picker ? ["--picker"] : []),
        "--snapshot",
        resolve(request.out),
        ...pair("--width", request.width),
        ...pair("--height", request.height),
        ...pair("--at", request.atSeconds),
        ...pair("--tab", request.tab),
        ...pair("--select-zoom", request.selectZoom),
        ...pair("--select-clip", request.selectClip),
        ...span("--part", request.part),
        ...span("--range", request.range),
        ...pair("--comment", request.comment),
        ...pair("--filter", request.filter),
        ...(request.shortcuts ? ["--shortcuts"] : []),
    ];
}

/** A snapshot run prints no answer line: it worked when it exited 0 and the picture is there. */
export function snapshotAnswer(run: FaceRun, out: string): { ok: true; path: string } | { ok: false; error: string } {
    const path = resolve(out);

    if (run.code === 0 && existsSync(path)) {
        return { ok: true, path };
    }

    return { ok: false, error: `the snapshot exited ${run.code}: ${(run.stderr || run.stdout).trim().slice(-400)}` };
}
