import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { requireSibling } from "@genesiscz/utils/fs/module-dir";
import type { TranscriptLocator } from "./parts";

function isTranscriptLocator(value: unknown): value is TranscriptLocator {
    return (
        typeof value === "object" &&
        value !== null &&
        "find" in value &&
        typeof value.find === "function" &&
        "pathRoots" in value &&
        typeof value.pathRoots === "function" &&
        "sessionOfPath" in value &&
        typeof value.sessionOfPath === "function" &&
        "workerNative" in value &&
        typeof value.workerNative === "function" &&
        "titledSessions" in value &&
        typeof value.titledSessions === "function"
    );
}

/** A window of native records to turns, the shape of `TranscriptFacts.windowTurns`. */
type WindowTurns = (values: Record<string, unknown>[]) => TranscriptTurn[];

function isWindowTurns(value: unknown): value is WindowTurns {
    return typeof value === "function" && value.length <= 1;
}

/**
 * The window-turns function of a driver's `transcript` part, loaded beside the driver on the first call, for the same
 * reason as `deferredLocator`: the turn parsers it reaches cost 31 to 42 ms to import (measured 2026-10-31), and
 * `transcriptAround` is synchronous.
 */
export function deferredWindowTurns(meta: ImportMeta, module: string, exportName: string): WindowTurns {
    let loaded: WindowTurns | undefined;

    return (values) => {
        if (!loaded) {
            const exports: unknown = requireSibling(meta, module);
            const value: unknown =
                typeof exports === "object" && exports !== null ? Reflect.get(exports, exportName) : undefined;

            if (!isWindowTurns(value)) {
                throw new Error(`${module} exports no window-turns function named ${exportName}`);
            }

            loaded = value;
        }

        return loaded(values);
    };
}

/**
 * A `locate` part that loads its implementation beside the driver on the first call (`requireSibling`), so importing
 * a driver stays cheap on the hook path while the part stays synchronous (`resolveTranscriptsWith`). Measured
 * 2026-10-31, medians of 9 interleaved runs: the three locator modules added 1.7 ms to `src/utils/agent/host.ts`
 * when the drivers imported them directly (4.11 ms against 2.41 ms).
 */
export function deferredLocator(meta: ImportMeta, module: string, exportName: string): TranscriptLocator {
    let loaded: TranscriptLocator | undefined;

    const impl = (): TranscriptLocator => {
        if (loaded) {
            return loaded;
        }

        const exports: unknown = requireSibling(meta, module);
        const value: unknown =
            typeof exports === "object" && exports !== null ? Reflect.get(exports, exportName) : undefined;

        if (!isTranscriptLocator(value)) {
            throw new Error(`${module} exports no transcript locator named ${exportName}`);
        }

        loaded = value;
        return value;
    };

    return {
        pathRoots: (roots) => impl().pathRoots(roots),
        sessionOfPath: (file) => impl().sessionOfPath(file),
        find: (query, roots, fs) => impl().find(query, roots, fs),
        workerNative: (worker, fs) => impl().workerNative(worker, fs),
        titledSessions: (search) => impl().titledSessions(search),
    };
}
