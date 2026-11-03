import type { JobInfo } from "@genesiscz/utils/jobs";
import { z } from "zod";
import type { DisplayInfo } from "./types";

/** Every method a recorder can serve, by its JSON-RPC name. A recorder lists the ones it implements in `methods`. */
export const RECORDER_METHODS = [
    "status",
    "pause",
    "resume",
    "stop",
    "discard",
    "restart",
    "target.switch",
    "displays.list",
    "displays.add",
    "displays.remove",
    "displays.switch",
    "displays.mode",
    "jobs.list",
] as const;
export type RecorderMethod = (typeof RECORDER_METHODS)[number];

export const RECORDER_STATES = ["recording", "paused", "stopping"] as const;
export type RecorderState = (typeof RECORDER_STATES)[number];

/** JSON-RPC 2.0 error codes: the standard ones, and the recorder's own from 1001. */
export const RPC_ERRORS = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    unknownDisplay: 1001,
    notPaused: 1002,
    alreadyStopped: 1003,
    alreadyPaused: 1004,
    lastDisplay: 1005,
    unsupported: 1006,
} as const;

export class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "RpcError";
    }
}

export interface RecorderStatus {
    kind: string;
    title: string;
    state: RecorderState;
    displays: Array<{ id: number; name: string }>;
    frames: number;
    lastFrameAt?: string;
    warning?: string;
    folder?: string;
}

export type DisplayEntry = DisplayInfo & { recorded: boolean };

/** `all`, `follow-focus`, `main` or a screen index. */
export const displayModeSchema = z.union([z.enum(["all", "follow-focus", "main"]), z.number().int().nonnegative()]);
export type DisplayMode = z.infer<typeof displayModeSchema>;

export interface DisplaySelection {
    mode: DisplayMode;
    /** The displays chosen by id over the policy, or null when the policy decides. */
    chosen: number[] | null;
    /** How the change took effect: on the running capture, a capture started or stopped, a restart, the next piece. */
    applied: "live" | "started" | "stopped" | "restart" | "next-piece";
}

export interface StopAnswer {
    state: "stopping" | "stopped";
    /** How the recording ended: `requested`, `failed`, `done`, `discarded`, … */
    outcome?: string;
    /** The post-processing job; with `wait: false` the answer comes before it ends. */
    job?: string;
    frames?: number;
    /** What post-processing reported, one line each. */
    notes?: string[];
}

function unsupported(kind: string, method: RecorderMethod): never {
    throw new RpcError(RPC_ERRORS.unsupported, `a ${kind} recording has no ${method}`);
}

/**
 * The control surface of one running recording, the same for every recorder kind: the meetings recorder, the control
 * capture session, and a remote one over the live recording socket (`RecorderClient`). A kind implements what it has
 * and lists it in `methods`; the rest answers `unsupported`.
 */
export abstract class RecorderControl {
    abstract readonly kind: string;
    abstract readonly methods: readonly RecorderMethod[];

    abstract status(): Promise<RecorderStatus>;
    abstract pause(): Promise<{ state: RecorderState }>;
    abstract resume(): Promise<{ state: RecorderState }>;
    /** Answers after post-processing; with `wait: false` at once, with the post-processing job. */
    abstract stop(options?: { wait?: boolean }): Promise<StopAnswer>;

    /** Ends the recording and deletes what it recorded. */
    async discard(): Promise<StopAnswer> {
        return unsupported(this.kind, "discard");
    }

    /** Deletes what was recorded so far and records again. */
    async restart(): Promise<{ state: RecorderState }> {
        return unsupported(this.kind, "restart");
    }

    /** Records another target of the recorder's own kind (a window, an app, a display). */
    async switchTarget(_target: unknown): Promise<{ state: RecorderState }> {
        return unsupported(this.kind, "target.switch");
    }

    async listDisplays(): Promise<DisplayEntry[]> {
        return unsupported(this.kind, "displays.list");
    }

    async addDisplay(_displayId: number): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.add");
    }

    async removeDisplay(_displayId: number): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.remove");
    }

    async switchDisplay(_displayId: number): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.switch");
    }

    async setDisplayMode(_mode: DisplayMode): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.mode");
    }

    /** The post-processing jobs (OCR backlog, segment join, meeting refresh and collect), newest last. */
    async listJobs(): Promise<JobInfo[]> {
        return [];
    }
}

const displayIdParams = z.object({ displayId: z.number().int() });

function parse<T>(schema: z.ZodType<T>, params: unknown, hint: string): T {
    const parsed = schema.safeParse(params ?? {});

    if (!parsed.success) {
        throw new RpcError(RPC_ERRORS.invalidParams, `give ${hint}`);
    }

    return parsed.data;
}

/** One entry per method: how its JSON-RPC params reach the RecorderControl method. */
export const RECORDER_DISPATCH: Record<
    RecorderMethod,
    (control: RecorderControl, params: unknown) => Promise<unknown>
> = {
    status: (control) => control.status(),
    pause: (control) => control.pause(),
    resume: (control) => control.resume(),
    stop: (control, params) =>
        control.stop(parse(z.object({ wait: z.boolean().optional() }), params, "{ wait?: boolean }")),
    discard: (control) => control.discard(),
    restart: (control) => control.restart(),
    "target.switch": (control, params) =>
        control.switchTarget(parse(z.object({ target: z.unknown() }), params, "{ target }").target),
    "displays.list": (control) => control.listDisplays(),
    "displays.add": (control, params) =>
        control.addDisplay(parse(displayIdParams, params, "{ displayId: <number> }").displayId),
    "displays.remove": (control, params) =>
        control.removeDisplay(parse(displayIdParams, params, "{ displayId: <number> }").displayId),
    "displays.switch": (control, params) =>
        control.switchDisplay(parse(displayIdParams, params, "{ displayId: <number> }").displayId),
    "displays.mode": (control, params) =>
        control.setDisplayMode(
            parse(z.object({ mode: displayModeSchema }), params, "{ mode: all | follow-focus | main | <index> }").mode
        ),
    "jobs.list": (control) => control.listJobs(),
};

export function isRecorderMethod(name: string): name is RecorderMethod {
    return (RECORDER_METHODS as readonly string[]).includes(name);
}
