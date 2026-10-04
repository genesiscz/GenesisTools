import type { AutoLogger } from "./types";

export interface AutoLogEntry {
    kind: "import" | "component" | "prop" | "type" | "warning" | "debug";
    file: string;
    message: string;
    details?: unknown;
}

export interface RecordingAutoLogger extends AutoLogger {
    /** Every reported change, in call order */
    readonly entries: AutoLogEntry[];
}

/**
 * An AutoLogger that records every reported change in memory, for a codemod's end-of-run report or a test.
 */
export function createAutoLogger(): RecordingAutoLogger {
    const entries: AutoLogEntry[] = [];

    const record = (entry: AutoLogEntry): void => {
        entries.push(entry);
    };

    return {
        entries,
        importChange: (file, mod, nameOrKind, action, details) => {
            record({ kind: "import", file, message: `${action} import ${nameOrKind} (${mod})`, details });
        },
        componentRename: (file, fromName, toName) => {
            record({ kind: "component", file, message: `renamed component ${fromName} -> ${toName}` });
        },
        propChange: (file, component, prop, action, details) => {
            record({ kind: "prop", file, message: `${action} prop ${prop} on ${component}`, details });
        },
        typeChange: (file, fromType, action, toType) => {
            record({ kind: "type", file, message: `${action} type ${fromType} -> ${toType}` });
        },
        warning: (file, message) => {
            record({ kind: "warning", file, message });
        },
        debug: (file, message) => {
            record({ kind: "debug", file, message });
        },
    };
}
