import { basename, dirname } from "node:path";
import type { RpcProgress, RpcRequestOptions } from "@genesiscz/utils/rpc/peer";
import { RPC_ERRORS, RpcError } from "@genesiscz/utils/screen-recorder/control";
import type { z } from "zod";
import {
    type EditorOpenState,
    editorOpenArgs,
    exportAnswerSchema,
    exportArgv,
    type FaceRun,
    faceAnswer,
    openWithApp,
    readEditorOpenState,
    recorderFaceArgs,
    recorderWindowArgs,
    runFaceProcess,
    sheetAnswerSchema,
    sheetArgv,
    snapshotAnswer,
    snapshotArgv,
    stillAnswerSchema,
    stillArgv,
} from "./library";
import {
    HOST_SCHEMAS,
    HOST_TIMEOUT_MS,
    type HostMethod,
    type HostParams,
    type HostResult,
    type spanSchema,
} from "./service-protocol";

/** What a host call gets beside its params: a cancel, and the progress the side doing the work reports. */
export interface HostCallContext {
    signal?: AbortSignal;
    onProgress?: (update: RpcProgress) => void;
}

/**
 * The side that can draw: it opens and lists editor windows, renders stills, sheets, movies and snapshots, and runs
 * the camera. `ConnectedAppHost` is GenesisTools.app's recorder face connected to the recorder service, and
 * `HeadlessHost` runs today's headless face for each call. A client of the service reaches either through the
 * service (`ServiceHost` in service-client.ts).
 */
export interface RecorderHost {
    readonly kind: "app" | "headless" | "service";
    /** Whether it answers the method now; the service falls back to the headless way when it does not. */
    answers(method: HostMethod): boolean;
    call<M extends HostMethod>(method: M, params: HostParams<M>, context?: HostCallContext): Promise<HostResult<M>>;
}

/** The part of a service connection a host adapter needs. */
export interface HostConnection {
    readonly closed: boolean;
    request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T>;
}

/** Validates a host's answer against the method's result schema, so a reply of the wrong shape is a refusal. */
export function hostAnswer<M extends HostMethod>(method: M, raw: unknown): HostResult<M> {
    const schemas: (typeof HOST_SCHEMAS)[M] = HOST_SCHEMAS[method];
    return schemas.result.parse(raw);
}

/** GenesisTools.app's recorder face, connected to the service: every call is a request over its connection. */
export class ConnectedAppHost implements RecorderHost {
    readonly kind = "app";

    constructor(
        private readonly connection: HostConnection,
        /** The methods its `hello` named; absent: all of them. */
        private readonly answered?: readonly string[]
    ) {}

    get closed(): boolean {
        return this.connection.closed;
    }

    answers(method: HostMethod): boolean {
        return !this.connection.closed && (!this.answered || this.answered.includes(method));
    }

    async call<M extends HostMethod>(
        method: M,
        params: HostParams<M>,
        context: HostCallContext = {}
    ): Promise<HostResult<M>> {
        const raw = await this.connection.request(method, params, {
            timeoutMs: HOST_TIMEOUT_MS[method],
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.onProgress ? { onProgress: context.onProgress } : {}),
        });
        return hostAnswer(method, raw);
    }
}

/** What the headless host runs: the face (`--still`, `--sheet`, `--export`, `--snapshot`), `open`, editor-open.json. */
export interface HeadlessDeps {
    runFace: (argv: string[], signal?: AbortSignal) => Promise<FaceRun>;
    open: (args: string[]) => void;
    editorState: () => EditorOpenState | null;
}

const HEADLESS_DEPS: HeadlessDeps = { runFace: runFaceProcess, open: openWithApp, editorState: readEditorOpenState };

/** A face run's answer line, or a refusal with the face's own reason. */
function faceResult<M extends HostMethod, T extends { ok: boolean; error?: string }>({
    method,
    run,
    schema,
    what,
}: {
    method: M;
    run: FaceRun;
    schema: z.ZodType<T>;
    what: string;
}): HostResult<M> {
    const answer = faceAnswer(run, schema, what);

    if (!answer.ok) {
        throw new RpcError(RPC_ERRORS.internal, answer.error ?? `the ${what} failed without a reason`);
    }

    return hostAnswer(method, answer);
}

function spanOf(value: z.infer<typeof spanSchema> | undefined): { from: number; to: number } | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value === "string") {
        const [from, to] = value.split("-").map(Number);
        return { from, to };
    }

    return Array.isArray(value) ? { from: value[0], to: value[1] } : value;
}

/** The recording folder an edit path names, as the editor's window rows do. */
function folderOf(path: string): string {
    return basename(path).endsWith(".json") ? dirname(path) : path;
}

type HeadlessTable = {
    [M in HostMethod]: (deps: HeadlessDeps, params: HostParams<M>, context: HostCallContext) => Promise<HostResult<M>>;
};

/** Each host method the way it works without a connected app. */
const HEADLESS: HeadlessTable = {
    "window.open": async (deps, params) => {
        deps.open(
            editorOpenArgs(params.path, { focus: params.focus ?? true, atSeconds: params.atSeconds, tab: params.tab })
        );
        // The window opens through the app's arguments: its number is known once editor-open.json lists it, else 0.
        const row = deps.editorState()?.open.find((each) => each.path === folderOf(params.path));
        return { opened: true, window: row?.window ?? 0 };
    },
    "window.show": async (deps, params) => {
        deps.open(recorderWindowArgs(params.which, { focus: params.focus ?? true }));
        return { shown: true };
    },
    "window.list": async (deps) => {
        const state = deps.editorState();
        const row = (each: { path: string; title: string; window?: number }) => ({
            path: each.path,
            title: each.title,
            window: each.window ?? 0,
        });
        return {
            ...(state?.front ? { front: row(state.front) } : {}),
            open: (state?.open ?? []).map(row),
        };
    },
    "render.still": async (deps, params, context) =>
        faceResult({
            method: "render.still",
            run: await deps.runFace(
                stillArgv({ path: params.path, atSeconds: params.atSeconds ?? 0, out: params.out, full: params.full }),
                context.signal
            ),
            schema: stillAnswerSchema,
            what: "still",
        }),
    "render.sheet": async (deps, params, context) =>
        faceResult({
            method: "render.sheet",
            run: await deps.runFace(sheetArgv(params), context.signal),
            schema: sheetAnswerSchema,
            what: "sheet",
        }),
    "render.export": async (deps, params, context) =>
        faceResult({
            method: "render.export",
            run: await deps.runFace(exportArgv(params.path, params.out), context.signal),
            schema: exportAnswerSchema,
            what: "export",
        }),
    "render.snapshot": async (deps, params, context) => {
        const run = await deps.runFace(
            snapshotArgv({
                ...params,
                path: params.path ?? params.edit,
                part: spanOf(params.part),
                range: spanOf(params.range),
            }),
            context.signal
        );
        const answer = snapshotAnswer(run, params.out);

        if (!answer.ok) {
            throw new RpcError(RPC_ERRORS.internal, answer.error);
        }

        // The face names how it captured on stderr: "recorder snapshot: <path> by <method> (…)".
        const method = /\bby (\S+)/.exec(run.stderr)?.[1] ?? "headless";
        return { ok: true, path: answer.path, method };
    },
    "camera.start": async () => {
        throw new RpcError(
            RPC_ERRORS.hostUnavailable,
            "the camera needs GenesisTools.app's recorder face connected to the recorder service as its host"
        );
    },
    "camera.stop": async () => {
        throw new RpcError(
            RPC_ERRORS.hostUnavailable,
            "the camera needs GenesisTools.app's recorder face connected to the recorder service as its host"
        );
    },
};

/** Today's headless recorder face, run once per call; it answers every method but the camera's. */
export class HeadlessHost implements RecorderHost {
    readonly kind = "headless";
    private readonly deps: HeadlessDeps;

    constructor(deps: Partial<HeadlessDeps> = {}) {
        this.deps = { ...HEADLESS_DEPS, ...deps };
    }

    answers(method: HostMethod): boolean {
        return method !== "camera.start" && method !== "camera.stop";
    }

    /** Starts the recorder face in the background with no window: its menu, and its host connection. */
    launchFace(): void {
        this.deps.open(recorderFaceArgs());
    }

    /** The window number editor-open.json lists for an edit's recording, when it lists it. */
    windowOf(path: string): number | undefined {
        return this.deps.editorState()?.open.find((each) => each.path === folderOf(path))?.window;
    }

    call<M extends HostMethod>(
        method: M,
        params: HostParams<M>,
        context: HostCallContext = {}
    ): Promise<HostResult<M>> {
        const run: HeadlessTable[M] = HEADLESS[method];
        return run(this.deps, params, context);
    }
}
