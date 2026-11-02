import type { SessionChangesRead } from "@genesiscz/utils/agent-sessions/types";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { requireSibling } from "@genesiscz/utils/fs/module-dir";
import type { TranscriptLocator } from "./parts";

function isTranscriptLocator(value: unknown): value is TranscriptLocator {
    return (
        typeof value === "object" &&
        value !== null &&
        "defaultRoots" in value &&
        typeof value.defaultRoots === "function" &&
        "find" in value &&
        typeof value.find === "function" &&
        "pathRoots" in value &&
        typeof value.pathRoots === "function" &&
        "sessionOfPath" in value &&
        typeof value.sessionOfPath === "function" &&
        "workerNative" in value &&
        typeof value.workerNative === "function" &&
        "titledSessions" in value &&
        typeof value.titledSessions === "function" &&
        "rootsOfHome" in value &&
        typeof value.rootsOfHome === "function"
    );
}

/** A window of native records to turns, the shape of `NativeSessionReader.windowTurns`. */
type WindowTurns = (values: Record<string, unknown>[]) => TranscriptTurn[];

function isWindowTurns(value: unknown): value is WindowTurns {
    return typeof value === "function" && value.length <= 1;
}

/**
 * One export of a module beside `meta`, loaded on the first call and kept: the module is required synchronously
 * (`requireSibling`), its export checked by `guard`, and a missing or wrong export throws with both names.
 */
function lazyExport<T>(
    meta: ImportMeta,
    module: string,
    exportName: string,
    guard: (value: unknown) => value is T,
    what: string
): () => T {
    let loaded: T | undefined;

    return () => {
        if (loaded === undefined) {
            const exports: unknown = requireSibling(meta, module);
            const value: unknown =
                typeof exports === "object" && exports !== null ? Reflect.get(exports, exportName) : undefined;

            if (!guard(value)) {
                throw new Error(`${module} exports no ${what} named ${exportName}`);
            }

            loaded = value;
        }

        return loaded;
    };
}

/**
 * A reader's window-turns function, loaded beside the caller on the first call: the turn parsers it reaches cost 31 to
 * 42 ms to import (measured 2026-10-31), and `transcriptAround` is synchronous.
 */
export function deferredWindowTurns(meta: ImportMeta, module: string, exportName: string): WindowTurns {
    const impl = lazyExport(meta, module, exportName, isWindowTurns, "window-turns function");
    return (values) => impl()(values);
}

/** One session's changes as a reader reads them, the shape of `NativeSessionReader.readChanges`. */
type ReadChanges = (sessionId: string) => SessionChangesRead | null;

function isReadChanges(value: unknown): value is ReadChanges {
    return typeof value === "function" && value.length <= 1;
}

/**
 * A reader's change-reading function, loaded beside the caller on the first call: the change parsers it reaches (the
 * Claude tool-call parser, Codex's patch replay over the `diff` package) are needed by the hub and `tools agents
 * changes` only, never by a hook that loads a reader.
 */
export function deferredReadChanges(meta: ImportMeta, module: string, exportName: string): ReadChanges {
    const impl = lazyExport(meta, module, exportName, isReadChanges, "change reader");
    return (sessionId) => impl()(sessionId);
}

/**
 * A `locate` part that loads its implementation from the harness's reader files (`src/utils/agent-sessions/readers/
 * <module>.ts`, where every fact of its session files lives) on the first call, so importing a driver stays cheap on
 * the hook path while the part stays synchronous (`resolveTranscriptsWith`). Measured 2026-10-31, medians of 9
 * interleaved runs: the three locator modules added 1.7 ms to `src/utils/agent/host.ts` when the drivers imported them
 * directly (4.11 ms against 2.41 ms).
 */
export function deferredLocator(module: string, exportName: string): TranscriptLocator {
    const impl = lazyExport(
        import.meta,
        `../agent-sessions/readers/${module}`,
        exportName,
        isTranscriptLocator,
        "transcript locator"
    );

    return {
        defaultRoots: () => impl().defaultRoots(),
        pathRoots: (roots) => impl().pathRoots(roots),
        sessionOfPath: (file) => impl().sessionOfPath(file),
        find: (query, roots, fs) => impl().find(query, roots, fs),
        workerNative: (worker, fs) => impl().workerNative(worker, fs),
        titledSessions: (search) => impl().titledSessions(search),
        rootsOfHome: (home) => impl().rootsOfHome(home),
    };
}
