import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { MethodDescriptor } from "@genesiscz/utils/api-descriptor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import type { EditOp } from "@genesiscz/utils/recording-editor/project";
import { readProject } from "@genesiscz/utils/recording-editor/project";
import { editPathOf, editProject, type OpenedProject } from "./edit";
import { withEditSession } from "./edit-session";
import { resolveRecording } from "./library";
import { ServiceConnectionLost, withServiceClient } from "./service-client";
import { readLiveService, type ServiceEntry } from "./service-protocol";

/**
 * The CLI's and the REPL's edits, through the recorder service when one runs, so an edit the window holds open takes
 * them in memory; without one they run in the caller's process with the revision check (`editProject`).
 */

const { log } = logger.scoped("recorder-service-client");

/** A `movie.*` call through the service may run a long step (removeIdle over a meeting, a transcription). */
const MOVIE_CALL_TIMEOUT_MS = 60 * 60_000;
const EDIT_CALL_TIMEOUT_MS = 10 * 60_000;
/**
 * What the caller names, resolved here by the rules the in-process edit uses (a path against this cwd, a full or short
 * library id, "last", "open"): the service runs in another folder. `resolve(value)` sent "<cwd>/<id>" for an id, and
 * the service refused every edit by id while it ran (round 2, from recorder-capture).
 */
const callerPath = (value: string): string => resolveRecording(value);

/**
 * The params that name a file against the caller's cwd, per Movie method and per edit op of the same name; a name
 * missing here has `file` only. The service resolves a relative path against its own folder, so each is resolved
 * here first (CLI-F3). A new path param goes into this table.
 */
const PATH_PARAMS: ReadonlyMap<string, readonly string[]> = new Map([
    ["duplicate", ["file", "to"]],
    ["introCard", ["file", "logo"]],
    ["frame", ["file", "background.image"]],
    // The camera's file is not a cwd path: cameraBubbleSchema says "a bare name is beside the source movie", and the
    // in-process camera op stores it as written, so it goes to the service as written.
    ["camera", []],
    // The export's chosen file; "" (back to the default name) stays "".
    ["exportSettings", ["output"]],
]);
const DEFAULT_PATH_PARAMS: readonly string[] = ["file"];

/** A file path as the caller means it: `~/` is the home folder, a relative path is against this cwd; "" stays "". */
function callerFile(value: string): string {
    return value === "" ? value : resolve(value.replace(/^~(?=[/\\])/, homedir()));
}

/**
 * `params` of the Movie method or edit op `name` with every path in it resolved against the caller's cwd, and the
 * ops of `apply` the same way, before they go to the service. Other values stay as they are (a `to` of trim is a time).
 */
export function callerParams(name: string, params: Record<string, unknown>): Record<string, unknown> {
    const next: Record<string, unknown> = { ...params };

    for (const key of PATH_PARAMS.get(name) ?? DEFAULT_PATH_PARAMS) {
        const [head, field] = key.split(".");
        const value = next[head];

        if (!field && typeof value === "string") {
            next[head] = callerFile(value);
        } else if (field && typeof value === "object" && value !== null) {
            const inner: Record<string, unknown> = { ...value };

            if (typeof inner[field] === "string") {
                inner[field] = callerFile(inner[field]);
                next[head] = inner;
            }
        }
    }

    if (name === "apply" && Array.isArray(next.ops)) {
        next.ops = next.ops.map((op: unknown) => (isOp(op) ? callerParams(op.op, op) : op));
    }

    return next;
}

function isOp(value: unknown): value is Record<string, unknown> & { op: string } {
    return typeof value === "object" && value !== null && "op" in value && typeof value.op === "string";
}

interface ServiceEditAnswer {
    project: OpenedProject["project"];
    warnings?: string[];
    removedIdleUs?: Array<[number, number]>;
    loudness?: { measuredLufs: number | null; volume: number };
    undone?: string[];
    redone?: string[];
}

/** The edit's revision on its file now; null when it has no file yet or cannot be read. */
function revisionOnDisk(recording: string): number | null {
    try {
        const path = editPathOf(recording);
        return existsSync(path) ? readProject(path).revision : null;
    } catch (error) {
        log.debug({ error, recording }, "the edit's revision could not be read");
        return null;
    }
}

/**
 * Sends a call that changes the edit through the service, and when the connection closes under it (the service exits
 * when its code changes, and an editor saw "the connection closed" twice in one script, round 5 item 9), once more: on
 * the service that runs now, or in this process when none does. It is sent again only when it cannot apply twice: it
 * never left, or the edit's file is at the revision it had before the call. Otherwise it throws a clear error that
 * says the edit moved, so the caller reads info() instead of guessing.
 */
export async function sendOnce<T>(options: {
    what: string;
    recording: string;
    dir?: string;
    entry: ServiceEntry;
    send: (entry: ServiceEntry) => Promise<T>;
    local: () => Promise<T>;
}): Promise<T> {
    const before = revisionOnDisk(options.recording);

    try {
        return await options.send(options.entry);
    } catch (error) {
        if (!(error instanceof ServiceConnectionLost)) {
            throw error;
        }

        const after = revisionOnDisk(options.recording);

        if (error.sent && after !== before) {
            throw new Error(
                `${options.what}: ${error.message}. The edit moved while the call ran (revision ${before ?? "none"} → ${after ?? "none"}), so it was not sent again: info() shows whether it took effect.`
            );
        }

        const again = readLiveService(options.dir);
        log.warn(
            { what: options.what, sent: error.sent, reason: error.reason, again: again ? "service" : "local" },
            "the recorder service connection closed; sending the call once more"
        );

        try {
            return again ? await options.send(again) : await options.local();
        } catch (second) {
            if (second instanceof ServiceConnectionLost) {
                throw new Error(
                    `${options.what}: the connection to the recorder service closed twice (${error.reason}; then ${second.reason}). The edit is at revision ${revisionOnDisk(options.recording) ?? "none"}; info() shows it. ${toolCommand("recorder serve --status")} shows the service.`
                );
            }

            throw second;
        }
    }
}

function openedOf(value: string, answer: ServiceEditAnswer): OpenedProject {
    return {
        path: editPathOf(value),
        project: answer.project,
        fresh: false,
        ...(answer.warnings?.length ? { warnings: answer.warnings } : {}),
        ...(answer.removedIdleUs?.length ? { removedIdleUs: answer.removedIdleUs } : {}),
        ...(answer.loudness ? { loudness: answer.loudness } : {}),
        ...(answer.undone ? { undone: answer.undone } : {}),
        ...(answer.redone ? { redone: answer.redone } : {}),
    };
}

/**
 * `tools recorder apply`: through the running service (`edit.apply`), so an edit open in the window takes it in
 * memory; without one, in this process with the revision check (`editProject`).
 */
export async function applyEdit(
    value: string,
    ops: readonly EditOp[],
    options: { dir?: string } = {}
): Promise<OpenedProject> {
    const entry = readLiveService(options.dir);

    if (!entry) {
        return editProject(value, ops);
    }

    log.debug({ value, ops: ops.map((op) => op.op), socket: entry.socket }, "edit through the recorder service");
    return sendOnce({
        what: "apply",
        recording: value,
        dir: options.dir,
        entry,
        send: async (live) =>
            openedOf(
                value,
                await withServiceClient(live, (client) =>
                    client.call<ServiceEditAnswer>(
                        "edit.apply",
                        {
                            path: callerPath(value),
                            ops: ops.map((op) => callerParams(op.op, { ...op })),
                        },
                        { timeoutMs: EDIT_CALL_TIMEOUT_MS }
                    )
                )
            ),
        local: () => editProject(value, ops),
    });
}

/** `tools recorder undo`: through the running service (`edit.undo`), else on a short-lived session in this process. */
export async function undoLastEdit(value: string, options: { dir?: string } = {}): Promise<OpenedProject> {
    const entry = readLiveService(options.dir);

    if (!entry) {
        const path = editPathOf(value);
        const { project, undone } = await withEditSession(path, (session) => session.undo({ by: "agent" }));
        return { path, project, fresh: false, undone };
    }

    const answer = await withServiceClient(entry, (client) =>
        client.call<ServiceEditAnswer>("edit.undo", { path: callerPath(value) })
    );
    return openedOf(value, answer);
}

/** `tools recorder redo`: through the running service (`edit.redo`), else on a short-lived session in this process. */
export async function redoLastEdit(value: string, options: { dir?: string } = {}): Promise<OpenedProject> {
    const entry = readLiveService(options.dir);

    if (!entry) {
        const path = editPathOf(value);
        const { project, redone } = await withEditSession(path, (session) => session.redo({ by: "agent" }));
        return { path, project, fresh: false, redone };
    }

    const answer = await withServiceClient(entry, (client) =>
        client.call<ServiceEditAnswer>("edit.redo", { path: callerPath(value) })
    );
    return openedOf(value, answer);
}

/**
 * The Movie methods that stay in the caller's process: they draw, export or write beside the recording. transcript,
 * still, sheet and reveal were read before their effects were declared honestly (NR7); they still run here.
 */
const STAYS_LOCAL = new Set([
    "transcript",
    "still",
    "sheet",
    "reveal",
    "show",
    "export",
    "poster",
    "subtitles",
    "comment",
    "resolveComment",
    "uncomment",
    "importComments",
    "copy",
    "rename",
]);

/** Whether a Movie method goes to the running service: every one that changes the edit. */
export function forwardsToService(method: MethodDescriptor): boolean {
    return method.effect === "reversible" && !STAYS_LOCAL.has(method.name);
}

function paramsOf(
    method: MethodDescriptor,
    args: readonly unknown[]
): { params: Record<string, unknown>; signal?: AbortSignal } {
    const raw = method.positional
        ? Object.fromEntries(
              method.positional.map((key, index) => [key, args[index]]).filter(([, value]) => value !== undefined)
          )
        : args[0];
    const { signal, ...params }: Record<string, unknown> = typeof raw === "object" && raw !== null ? { ...raw } : {};
    return { params, ...(signal instanceof AbortSignal ? { signal } : {}) };
}

/**
 * A REPL's Movie whose edit methods run in the recorder service when one runs (`movie.<name> { recording, … }`),
 * so the window's open edit and the REPL change one copy; without a service, or for the methods that stay local,
 * the Movie runs them itself.
 */
export function serviceRoutedMovie<T extends { recording: string }>(
    movie: T,
    methods: readonly MethodDescriptor[],
    options: { dir?: string } = {}
): T {
    const forwarded = new Map(methods.filter(forwardsToService).map((method) => [method.name, method]));

    return new Proxy(movie, {
        get: (target, property, receiver) => {
            const value: unknown = Reflect.get(target, property, receiver);
            const method = typeof property === "string" ? forwarded.get(property) : undefined;

            if (!method || typeof value !== "function") {
                return typeof value === "function" ? value.bind(target) : value;
            }

            return async (...args: unknown[]) => {
                const entry = readLiveService(options.dir);

                if (!entry) {
                    return Reflect.apply(value, target, args);
                }

                const { params: raw, signal } = paramsOf(method, args);
                const params = callerParams(method.name, raw);
                log.debug(
                    { method: method.name, recording: target.recording },
                    "movie call through the recorder service"
                );
                return sendOnce({
                    what: `movie.${method.name}`,
                    recording: target.recording,
                    dir: options.dir,
                    entry,
                    send: (live) =>
                        withServiceClient(live, (client) =>
                            client.call(
                                `movie.${method.name}`,
                                { recording: callerPath(target.recording), ...params },
                                { timeoutMs: MOVIE_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) }
                            )
                        ),
                    local: () => Reflect.apply(value, target, args),
                });
            };
        },
    });
}
