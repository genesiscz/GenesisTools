import { resolve } from "node:path";
import type { MethodDescriptor } from "@genesiscz/utils/api-descriptor";
import { logger } from "@genesiscz/utils/logger";
import type { EditOp } from "@genesiscz/utils/recording-editor/project";
import { editPathOf, editProject, type OpenedProject, undoEdit } from "./edit";
import { withServiceClient } from "./service-client";
import { readLiveService } from "./service-protocol";

/**
 * The CLI's and the REPL's edits, through the recorder service when one runs, so an edit the window holds open takes
 * them in memory; without one they run in the caller's process with the revision check (`editProject`).
 */

const { log } = logger.scoped("recorder-service-client");

/** A `movie.*` call through the service may run a long step (removeIdle over a meeting, a transcription). */
const MOVIE_CALL_TIMEOUT_MS = 60 * 60_000;
const EDIT_CALL_TIMEOUT_MS = 10 * 60_000;
const callerPath = (value: string): string => value === "last" || value === "open" ? value : resolve(value);

interface ServiceEditAnswer {
    project: OpenedProject["project"];
    warnings?: string[];
    removedIdleUs?: Array<[number, number]>;
    loudness?: { measuredLufs: number | null; volume: number };
    undone?: string[];
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
    const answer = await withServiceClient(entry, (client) =>
        client.call<ServiceEditAnswer>("edit.apply", { path: callerPath(value), ops: ops.map((op) => "file" in op && typeof op.file === "string" ? { ...op, file: resolve(op.file) } : op) }, { timeoutMs: EDIT_CALL_TIMEOUT_MS })
    );
    return openedOf(value, answer);
}

/** `tools recorder undo`: through the running service (`edit.undo`), else in this process (`undoEdit`). */
export async function undoLastEdit(value: string, options: { dir?: string } = {}): Promise<OpenedProject> {
    const entry = readLiveService(options.dir);

    if (!entry) {
        return undoEdit(value);
    }

    const answer = await withServiceClient(entry, (client) =>
        client.call<ServiceEditAnswer>("edit.undo", { path: callerPath(value) })
    );
    return openedOf(value, answer);
}

/** The Movie methods that stay in the caller's process: they draw, export or write beside the recording. */
const STAYS_LOCAL = new Set([
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

                const { params, signal } = paramsOf(method, args);

                if (typeof params.file === "string") {
                    params.file = resolve(params.file);
                }
                log.debug(
                    { method: method.name, recording: target.recording },
                    "movie call through the recorder service"
                );
                return withServiceClient(entry, (client) =>
                    client.call(
                        `movie.${method.name}`,
                        { recording: callerPath(target.recording), ...params },
                        { timeoutMs: MOVIE_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) }
                    )
                );
            };
        },
    });
}
