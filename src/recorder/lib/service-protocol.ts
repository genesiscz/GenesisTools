import { createHash } from "node:crypto";
import { join } from "node:path";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { editOpSchema, editProjectSchema } from "@genesiscz/utils/recording-editor/project";
import { RECORDER_METHODS } from "@genesiscz/utils/screen-recorder/control";
import { liveEntrySchema, liveSocketPath } from "@genesiscz/utils/screen-recorder/live";
import {
    RECORDING_EVENT,
    RECORDINGS_CHANGED,
    ROLES,
    SERVICE_PROTOCOL,
} from "@genesiscz/utils/screen-recorder/service-link";
import { z } from "zod";
import { EDITOR_TABS } from "./library";

/**
 * The recorder service's protocol: newline-delimited JSON-RPC 2.0 on `<recordings>/service.sock`, both directions on
 * one connection (the live recordings' framing). The service answers the edit methods; the host (GenesisTools.app's
 * recorder face) answers the window, render and camera methods, which the service forwards to it for any client.
 * Live recordings join it as `recording` connections: the service lists them and forwards control calls to them.
 * `__fixtures__/service-protocol.json` holds one example request and reply per method; the Swift host tests read it.
 * The discovery (`service.json`, the roles, the protocol number) lives in `@genesiscz/utils/screen-recorder/service-link`,
 * because the live recordings in that package join the service; it is re-exported here.
 */

export {
    ROLES,
    readLiveService,
    recorderServiceDir,
    SERVICE_PROTOCOL,
    type ServiceEntry,
    type ServiceRole,
    serviceEntryPath,
    serviceEntrySchema,
} from "@genesiscz/utils/screen-recorder/service-link";

export function serviceSocketPath(dir: string): string {
    return liveSocketPath(dir, "service");
}

export function servicePidPath(dir: string): string {
    return join(dir, "service.pid");
}

export const helloParamsSchema = z.object({
    role: z.enum(ROLES),
    protocol: z.number().int(),
    pid: z.number().int().positive(),
    /** A host: the host methods it answers. */
    answers: z.array(z.string()).optional(),
});

/** A live recording as the service holds it: the recording's discovery entry, sent on join and on every change. */
export const liveRecordingRowSchema = liveEntrySchema;
export type LiveRecordingRow = z.output<typeof liveRecordingRowSchema>;

/** `recordings.changed`: a recording registered, changed (its state, title, displays, warning or counts) or went. */
export const recordingsChangedSchema = z.object({
    id: z.string(),
    change: z.enum(["registered", "changed", "ended"]),
    recording: liveRecordingRowSchema.optional(),
});
export type RecordingsChanged = z.infer<typeof recordingsChangedSchema>;

/** `recording.event`: one live recording event (state, frame, displays, warning, progress, ended) with its id. */
export const recordingEventSchema = z.object({ id: z.string(), event: z.string(), params: z.unknown().optional() });
export const helloAnswerSchema = z.object({
    protocol: z.number().int(),
    methods: z.array(z.string()),
    version: z.string(),
});

const path = z.string().min(1);
/** What holds a session inside one connection (an editor window); absent is the connection itself. */
const holder = z.string().min(1).optional();
const ops = z.array(editOpSchema).min(1);
/** Output seconds as `{ from, to }`, `[from, to]` or `"from-to"`, as the host's `--snapshot` takes `part` and `range`. */
export const spanSchema = z.union([
    z.object({ from: z.number(), to: z.number() }),
    z.tuple([z.number(), z.number()]),
    z.string().regex(/^\d+(\.\d+)?-\d+(\.\d+)?$/),
]);
const project = { project: editProjectSchema, revision: z.number().int().nonnegative() };
const editAnswer = z.object({
    ...project,
    warnings: z.array(z.string()).optional(),
    removedIdleUs: z.array(z.tuple([z.number(), z.number()])).optional(),
    loudness: z.object({ measuredLufs: z.number().nullable(), volume: z.number() }).optional(),
});
const windowRow = z.object({ path: z.string(), title: z.string(), window: z.number().int() });
export const windowStateSchema = z.object({ front: windowRow.optional(), open: z.array(windowRow) });

/** The methods the service answers itself; `subscribe` is the transport's. */
export const serviceApi = defineApi({
    id: "recorder-service",
    global: "service",
    title: "Recorder service",
    summary: "The one owner of the recordings' edits while it runs, and the way to the recorder host.",
    methods: [
        defineMethod({
            name: "hello",
            params: helloParamsSchema,
            result: helloAnswerSchema,
            doc: "Names the connection's role; a host then answers the host methods. Another protocol is refused (1011), and a second host while the first is connected (1012).",
            effect: "read",
        }),
        defineMethod({
            name: "session.open",
            params: z.object({ path, holder }),
            // undoDepth: the undo steps the edit keeps (they outlive a close), so a reopened window can undo them.
            result: z.object({ path, ...project, undoDepth: z.number().int().nonnegative().optional() }),
            doc: "Opens (or holds once more) the edit session of a recording; the connection's holder holds it until session.close or the connection's end. Opening it again for the same holder reads it and adds no hold.",
            effect: "read",
        }),
        defineMethod({
            name: "session.close",
            params: z.object({ path, holder }),
            result: z.object({ closed: z.boolean() }),
            doc: "Lets go of the holder's hold; another holder of the same connection keeps its own, and the last hold saves and closes the session.",
            effect: "read",
        }),
        defineMethod({
            name: "edit.apply",
            params: z.object({ path, ops, baseRevision: z.number().int().nonnegative().optional() }),
            result: editAnswer,
            doc: "Applies ops as one change and one undo step; baseRevision refuses (1016) when the edit is at another revision.",
            effect: "reversible",
        }),
        defineMethod({
            name: "edit.undo",
            params: z.object({ path }),
            result: editAnswer.extend({ undone: z.array(z.string()) }),
            doc: "Puts the edit back as it was before its last change.",
            effect: "reversible",
        }),
        defineMethod({
            name: "edit.redo",
            params: z.object({ path }),
            result: editAnswer.extend({ redone: z.array(z.string()) }),
            doc: "Makes the last undone change again: the open session's, else the last undo saved to the file.",
            effect: "reversible",
        }),
        defineMethod({
            name: "gesture.begin",
            params: z.object({ path, gesture: z.string().min(1) }),
            result: z.object(project),
            doc: "Starts a drag on an open session.",
            effect: "read",
        }),
        defineMethod({
            name: "gesture.preview",
            params: z.object({ path, gesture: z.string().min(1), ops }),
            result: z.object({ project: editProjectSchema, superseded: z.literal(true).optional() }),
            doc: "The edit with the drag's ops applied, unsaved; each preview's ops replace the last one's.",
            effect: "read",
        }),
        defineMethod({
            name: "gesture.commit",
            params: z.object({ path, gesture: z.string().min(1) }),
            result: editAnswer,
            doc: "Makes the drag's last preview one change and one undo step.",
            effect: "reversible",
        }),
        defineMethod({
            name: "gesture.cancel",
            params: z.object({ path, gesture: z.string().min(1) }),
            result: z.object(project),
            doc: "Ends the drag with no change.",
            effect: "read",
        }),
        defineMethod({
            name: "recordings.register",
            params: liveRecordingRowSchema,
            result: z.object({ registered: z.literal(true), id: z.string() }),
            doc: "A recording connection names its live recording (its entry); sent again as a notification on every change. Subscribers hear recordings.changed.",
            effect: "reversible",
        }),
        defineMethod({
            name: "recordings.live",
            params: z.object({}),
            result: z.object({ recordings: z.array(liveRecordingRowSchema) }),
            doc: "The live recordings registered now, oldest first.",
            effect: "read",
        }),
        defineMethod({
            name: "recording.call",
            params: z.object({
                id: z.string().min(1),
                method: z.enum(RECORDER_METHODS),
                params: z.unknown().optional(),
            }),
            result: z.unknown(),
            doc: "One control method of a live recording (status, pause, marker.add, stop, ...), answered by its process; 1020 when no such recording is registered.",
            effect: "reversible",
        }),
    ],
});

/** The methods the host answers; the service forwards them for any client, and answers some without a host. */
export const hostApi = defineApi({
    id: "recorder-host",
    global: "host",
    title: "Recorder host",
    summary: "What GenesisTools.app's recorder face does for the service: windows, renders, the camera.",
    methods: [
        defineMethod({
            name: "window.open",
            params: z.object({
                path,
                focus: z.boolean().optional(),
                atSeconds: z.number().nonnegative().optional(),
                tab: z.enum(EDITOR_TABS).optional(),
            }),
            result: z.object({ opened: z.literal(true), window: z.number().int() }),
            doc: "Opens (or brings back) the editor window of an edit; window is its window number.",
            effect: "read",
        }),
        defineMethod({
            name: "window.show",
            params: z.object({ which: z.enum(["library", "picker"]), focus: z.boolean().optional() }),
            result: z.object({ shown: z.literal(true) }),
            doc: "Shows the recordings library or the capture picker.",
            effect: "read",
        }),
        defineMethod({
            name: "window.list",
            params: z.object({}),
            result: windowStateSchema,
            doc: "The editor windows: each recording folder, its title and window number, and the one in front.",
            effect: "read",
        }),
        defineMethod({
            name: "window.close",
            params: z
                .object({ path: path.optional(), window: z.number().int().positive().optional() })
                .refine((params) => params.path !== undefined || params.window !== undefined, {
                    message:
                        "window.close needs path (a recording folder, its edit or its movie) or window (a number window.list names)",
                }),
            result: z.object({ closed: z.boolean(), window: z.number().int().optional() }),
            doc: "Closes the editor window of an edit (path) or a window number, as its close button does; closed: false when none shows it. 1021 while the window has a drag not saved yet or an export running; 1019 when a window is open but no host is connected to close it.",
            effect: "reversible",
        }),
        defineMethod({
            name: "render.still",
            params: z.object({
                path,
                atSeconds: z.number().nonnegative().optional(),
                out: z.string().optional(),
                full: z.boolean().optional(),
            }),
            result: z.object({
                ok: z.literal(true),
                path: z.string(),
                width: z.number(),
                height: z.number(),
                atSeconds: z.number().optional(),
            }),
            doc: "One frame of the edit as it exports, at output seconds; full renders at the export's size.",
            effect: "read",
        }),
        defineMethod({
            name: "render.sheet",
            params: z.object({
                path,
                times: z.array(z.number().nonnegative()).min(1),
                out: z.string().optional(),
                columns: z.number().int().min(1).max(48).optional(),
                // R6 10 effects sheet
                cut: z.array(z.boolean()).optional(),
            }),
            result: z.object({
                ok: z.literal(true),
                path: z.string(),
                width: z.number(),
                height: z.number(),
                times: z.array(z.number()).optional(),
                columns: z.number().optional(),
            }),
            doc: "Those frames of the edit (output seconds) on one grid picture; columns (absent: by the frames' shape, as close to a 16:9 sheet as whole rows allow); cut (one per time) marks the cells whose time the edit cuts.",
            effect: "read",
        }),
        defineMethod({
            name: "render.export",
            params: z.object({
                path,
                out: z.string().optional(),
                // R5 3 export size: the picture's exact pixels, one side (the other follows its shape) or both.
                size: z
                    .object({
                        width: z.number().int().min(16).max(8192).optional(),
                        height: z.number().int().min(16).max(8192).optional(),
                    })
                    .optional(),
            }),
            result: z.object({ ok: z.literal(true), path: z.string(), bytes: z.number(), seconds: z.number() }),
            doc: 'Renders the edit as a movie; the host sends $/progress { id, fraction, label: "export" } and stops on $/cancel.',
            effect: "reversible",
        }),
        defineMethod({
            name: "render.snapshot",
            params: z
                .object({
                    out: z.string().min(1),
                    path: z.string().optional(),
                    edit: z.string().optional(),
                    library: z.boolean().optional(),
                    picker: z.boolean().optional(),
                    shortcuts: z.boolean().optional(),
                    filter: z.string().optional(),
                    width: z.number().positive().optional(),
                    height: z.number().positive().optional(),
                    atSeconds: z.number().nonnegative().optional(),
                    tab: z.enum(EDITOR_TABS).optional(),
                    selectZoom: z.number().int().nonnegative().optional(),
                    selectClip: z.number().int().nonnegative().optional(),
                    part: spanSchema.optional(),
                    range: spanSchema.optional(),
                    comment: z.number().int().nonnegative().optional(),
                })
                .refine((params) => params.path || params.edit || params.library || params.picker, {
                    message: "render.snapshot needs path (an edit), library or picker",
                }),
            result: z.object({ ok: z.literal(true), path: z.string(), method: z.string() }),
            doc: "A picture of a recorder window as it would look: an edit's editor, the library or the picker.",
            effect: "read",
        }),
        defineMethod({
            name: "camera.start",
            params: z.object({ folder: path }),
            result: z.object({ started: z.literal(true) }),
            doc: "Starts the camera bubble for a recording folder; 1014 when macOS denies the camera, 1015 when it is busy.",
            effect: "reversible",
        }),
        defineMethod({
            name: "camera.stop",
            params: z.object({ folder: path }),
            result: z.object({ stopped: z.boolean() }),
            doc: "Stops the camera bubble of a recording folder.",
            effect: "reversible",
        }),
    ],
});

export type HostMethod = (typeof hostApi)["methods"][number]["name"];
type HostMethodNamed<M extends HostMethod> = Extract<(typeof hostApi)["methods"][number], { name: M }>;
export type HostParams<M extends HostMethod> = z.output<HostMethodNamed<M>["params"]>;
export type HostResult<M extends HostMethod> = z.output<HostMethodNamed<M>["result"]>;

export const HOST_METHODS: readonly HostMethod[] = hostApi.methods.map((method) => method.name);

export function isHostMethod(name: string): name is HostMethod {
    return HOST_METHODS.some((method) => method === name);
}

/** A host method's descriptor, for its params and result schemas. */
export function hostMethod<M extends HostMethod>(name: M): HostMethodNamed<M> {
    const method = hostApi.methods.find((candidate): candidate is HostMethodNamed<M> => candidate.name === name);

    if (!method) {
        throw new Error(`no host method ${name}`);
    }

    return method;
}

type HostSchemas = {
    [M in HostMethod]: { params: z.ZodType<HostParams<M>>; result: z.ZodType<HostResult<M>> };
};

/** Each host method's schemas, by name, so a call typed by its method parses its params and its answer. */
export const HOST_SCHEMAS: HostSchemas = {
    "window.open": hostMethod("window.open"),
    "window.show": hostMethod("window.show"),
    "window.list": hostMethod("window.list"),
    "window.close": hostMethod("window.close"),
    "render.still": hostMethod("render.still"),
    "render.sheet": hostMethod("render.sheet"),
    "render.export": hostMethod("render.export"),
    "render.snapshot": hostMethod("render.snapshot"),
    "camera.start": hostMethod("camera.start"),
    "camera.stop": hostMethod("camera.stop"),
};

/** How long one host call may take; each `$/progress` starts it again. */
export const HOST_TIMEOUT_MS: Record<HostMethod, number> = {
    "window.open": 30_000,
    "window.show": 30_000,
    "window.list": 10_000,
    "window.close": 10_000,
    "render.still": 120_000,
    "render.sheet": 120_000,
    "render.export": 30 * 60_000,
    "render.snapshot": 120_000,
    "camera.start": 30_000,
    "camera.stop": 10_000,
};

/**
 * Notifications: the service sends `project.changed` and `recordings.changed`, the host `window.changed` and a live
 * recording `recording.event` (the service passes both on).
 */
export const SERVICE_EVENTS = ["project.changed", "window.changed", RECORDINGS_CHANGED, RECORDING_EVENT] as const;

const requestId = z.union([z.number().int(), z.string()]);

/** Each notification's params: the two events and the transport's progress and cancel (`utils/rpc/peer.ts`). */
export const NOTIFICATION_SCHEMAS = {
    "project.changed": z.object({
        path: z.string(),
        revision: z.number().int().nonnegative(),
        by: z.string(),
        /** The change undid or redid one before it; absent for an edit. */
        action: z.enum(["undo", "redo"]).optional(),
    }),
    "window.changed": windowStateSchema,
    "$/progress": z.object({
        id: requestId,
        fraction: z.number().min(0).max(1).optional(),
        label: z.string().optional(),
    }),
    "$/cancel": z.object({ id: requestId }),
    // What a client hears about live recordings (the form the service sends, with the recording's id).
    "recordings.changed": recordingsChangedSchema,
    "recording.event": recordingEventSchema,
} as const;

/** `subscribe`'s params; the transport answers it (`utils/rpc/socket-server.ts`). */
export const subscribeParamsSchema = z.object({ events: z.array(z.string()).optional() });

/** The protocol's fingerprint, which `hello` answers: a change of the method list is a new version. */
export function protocolVersion(methods: readonly string[]): string {
    const text = `${SERVICE_PROTOCOL}\n${[...methods].sort().join("\n")}`;
    return createHash("sha1").update(text).digest("hex").slice(0, 12);
}
