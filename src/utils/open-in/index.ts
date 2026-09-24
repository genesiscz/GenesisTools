import { cmuxDriver } from "./cmux";
import { cursorDriver } from "./cursor";
import type { EditorDriver, TerminalDriver } from "./types";

export type { CmuxOps } from "./cmux";
export { cmuxCommandLine, cmuxDriver, liveCmuxOps } from "./cmux";
export { cursorArgv, cursorDriver, defaultArgvRunner, resolveCursorBinary } from "./cursor";
export type {
    ArgvRunner,
    EditorDriver,
    EditorTarget,
    OpenResult,
    RunResult,
    TerminalDriver,
    TerminalTarget,
} from "./types";

/** Driver ids a config may name. A new app is one driver file plus one entry here. */
export const EDITOR_DRIVER_IDS = ["cursor"] as const;
export const TERMINAL_DRIVER_IDS = ["cmux"] as const;

export type EditorDriverId = (typeof EDITOR_DRIVER_IDS)[number];
export type TerminalDriverId = (typeof TERMINAL_DRIVER_IDS)[number];

export function isEditorDriverId(value: unknown): value is EditorDriverId {
    return typeof value === "string" && (EDITOR_DRIVER_IDS as readonly string[]).includes(value);
}

export function isTerminalDriverId(value: unknown): value is TerminalDriverId {
    return typeof value === "string" && (TERMINAL_DRIVER_IDS as readonly string[]).includes(value);
}

export function editorDriver(id: EditorDriverId): EditorDriver {
    switch (id) {
        case "cursor":
            return cursorDriver();
    }
}

export function terminalDriver(id: TerminalDriverId): TerminalDriver {
    switch (id) {
        case "cmux":
            return cmuxDriver();
    }
}
