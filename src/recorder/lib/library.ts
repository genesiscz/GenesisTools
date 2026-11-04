import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appStatus, buildApp } from "@app/macos/lib/permissions/app";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { readRecordingManifest, recordingsLibraryDir } from "@genesiscz/utils/screen-recorder/library";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

const { log } = logger.scoped("recorder-library");

/** The movie a recording folder holds, in the order the editor looks for one. */
export const RECORDING_MOVIES = ["screen.mp4", "screen.mov", "proxy.mp4"] as const;

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
}

export function movieOf(folder: string): string | undefined {
    return RECORDING_MOVIES.map((name) => join(folder, name)).find((path) => existsSync(path));
}

/** Every library recording, newest first. */
export function listLibrary(root = recordingsLibraryDir()): LibraryRow[] {
    if (!existsSync(root)) {
        return [];
    }

    const rows: LibraryRow[] = [];

    for (const name of readdirSync(root)) {
        const folder = join(root, name);
        const manifest = readRecordingManifest(folder);

        if (!manifest) {
            continue;
        }

        rows.push({
            id: manifest.id,
            title: manifest.title,
            folder,
            startedAt: manifest.startedAt,
            endedAt: manifest.endedAt,
            movie: movieOf(folder),
            frames: manifest.frames.length,
            edited: existsSync(join(folder, "edit.json")),
        });
    }

    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * What a recording argument names: a library id (`library-…`), `last` (the newest), a meeting id (its folder), or a
 * path to a movie, a recording folder or an edit file. Throws with the ids it knows when nothing matches.
 */
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
        const newest = listLibrary()[0];

        if (!newest) {
            throw new Error("The recordings library is empty; record one with " + toolCommand("recorder start") + ".");
        }

        return newest.folder;
    }

    const path = resolve(value);

    if (existsSync(path)) {
        return path;
    }

    const folder = recordingsLibraryDir(value);

    if (existsSync(folder) && statSync(folder).isDirectory()) {
        return folder;
    }

    // A meeting id: the meeting's folder holds its frames (and, once the editor opened it, recording.json).
    const meeting = toolDataDir("meetings", value);

    if (existsSync(join(meeting, "frames")) && statSync(meeting).isDirectory()) {
        return meeting;
    }

    const known = listLibrary()
        .slice(0, 5)
        .map((row) => row.id);
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

const editorWindowSchema = z.object({ path: z.string(), title: z.string() });
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

/** Opens the recordings library window, where a double-click opens a recording in the editor. */
export function openLibraryWindow({ focus = true }: { focus?: boolean } = {}): void {
    const args = ["-n", ...(focus ? [] : ["-g"]), genesisAppBundlePath(), "--args", "--recorder", "--library"];

    if (!focus) {
        args.push("--no-focus");
    }

    log.debug({ args }, "recorder: open the library");
    const result = spawnSync("open", args, { encoding: "utf8" });

    if (result.status !== 0) {
        throw new Error(`open failed (${result.status}): ${(result.stderr || result.error?.message || "").trim()}`);
    }
}

/** Opens the editor through Launch Services; a running recorder takes the request. */
/** The editor window's inspector tabs, as `--tab` takes them. */
export const EDITOR_TABS = ["zoom", "clip", "hide", "text", "style", "cursor", "captions", "audio", "export"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

/** Opens the editor window on `path`; `atSeconds` (output time) and `tab` place it at a moment and a panel. */
export function openEditor(
    path: string,
    { focus = true, atSeconds, tab }: { focus?: boolean; atSeconds?: number; tab?: EditorTab } = {}
): void {
    const args = ["-n", ...(focus ? [] : ["-g"]), genesisAppBundlePath(), "--args", "--recorder", "--edit", path];

    if (!focus) {
        args.push("--no-focus");
    }

    if (atSeconds !== undefined) {
        args.push("--at", String(atSeconds));
    }

    if (tab) {
        args.push("--tab", tab);
    }

    log.debug({ args }, "recorder: open the editor");
    const result = spawnSync("open", args, { encoding: "utf8" });

    if (result.status !== 0) {
        throw new Error(`open failed (${result.status}): ${(result.stderr || result.error?.message || "").trim()}`);
    }
}

const stillAnswerSchema = z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    error: z.string().optional(),
});
export type StillAnswer = z.infer<typeof stillAnswerSchema>;

const exportAnswerSchema = z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    bytes: z.number().optional(),
    seconds: z.number().optional(),
    error: z.string().optional(),
});
export type ExportAnswer = z.infer<typeof exportAnswerSchema>;

/**
 * Runs a headless step of the app's recorder face (`--export`, `--still`) and reads the one JSON line it prints
 * last; an exit without one becomes `{ ok: false }` with the end of its output.
 */
async function runRecorderFace<T extends { ok: boolean; error?: string }>({
    argv,
    schema,
    what,
}: {
    argv: string[];
    schema: z.ZodType<T>;
    what: string;
}): Promise<T | { ok: false; error: string }> {
    const binary = join(genesisAppBundlePath(), "Contents/MacOS/GenesisTools");
    log.debug({ binary, argv }, `recorder: headless ${what}`);
    const child = spawn(binary, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    const code = await new Promise<number>((done) => child.on("close", (status) => done(status ?? 1)));
    const line = stdout.trim().split("\n").at(-1) ?? "";
    const parsed = schema.safeParse(parseOrUndefined(line));

    if (parsed.success) {
        log.debug({ code, answer: parsed.data }, `recorder: ${what} finished`);
        return parsed.data;
    }

    log.warn({ code, stdout, stderr }, `recorder: ${what} printed no answer`);
    return { ok: false, error: `the ${what} exited ${code}: ${(stderr || stdout).trim().slice(-400)}` };
}

function parseOrUndefined(line: string): unknown {
    try {
        return SafeJSON.parse(line, { strict: true });
    } catch (error) {
        log.debug({ error, line }, "recorder: not a JSON line");
        return undefined;
    }
}

/** One frame of the edit as it exports (zoom, clicks, frame style), from a headless run of the recorder face. */
export function stillOfEdit({
    path,
    atSeconds,
    out,
    full = false,
}: {
    path: string;
    atSeconds: number;
    out: string;
    /** The export's size (a poster frame) instead of the 1080 pixel preview. */
    full?: boolean;
}) {
    return runRecorderFace({
        argv: [
            "--recorder",
            "--still",
            path,
            "--at",
            String(atSeconds),
            "--out",
            resolve(out),
            ...(full ? ["--full"] : []),
        ],
        schema: stillAnswerSchema,
        what: "still",
    });
}

const sheetAnswerSchema = z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    times: z.array(z.number()).optional(),
    error: z.string().optional(),
});
export type SheetAnswer = z.infer<typeof sheetAnswerSchema>;

/** Several frames of an edit (OUTPUT seconds) on one picture in rows of three, each labelled with its time. */
export function sheetOfEdit({ path, times, out }: { path: string; times: number[]; out: string }) {
    return runRecorderFace({
        argv: ["--recorder", "--sheet", path, "--times", times.join(","), "--out", resolve(out)],
        schema: sheetAnswerSchema,
        what: "sheet",
    });
}

/**
 * Renders an edit with the editor's own renderer (AVFoundation, hardware encoder) in a headless run of the app's
 * recorder face, so an agent's export is the movie the window would export.
 */
export function exportEdit(path: string, out?: string): Promise<ExportAnswer> {
    return runRecorderFace({
        argv: ["--recorder", "--export", path, "--json", ...(out ? ["--out", resolve(out)] : [])],
        schema: exportAnswerSchema,
        what: "export",
    });
}
