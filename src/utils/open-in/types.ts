/** A file (optionally at a line) inside a checkout, for an editor driver. */
export interface EditorTarget {
    /** The checkout or folder the editor opens as its workspace. */
    root: string;
    /** Absolute path of the file to show; omit to open only the folder. */
    file?: string;
    line?: number;
    column?: number;
}

/** A folder for a terminal driver, and optionally one argv to run there. */
export interface TerminalTarget {
    cwd: string;
    /** Tab or workspace title. */
    title?: string;
    /**
     * Run this argv in the new terminal. Terminals are shells, so drivers quote every element on
     * its own; an element can never split into two or be read as shell syntax.
     */
    argv?: string[];
}

export interface OpenResult {
    driver: string;
    /** One human line: what opened where. */
    detail: string;
}

export interface EditorDriver {
    kind: "editor";
    id: string;
    label: string;
    open(target: EditorTarget): Promise<OpenResult>;
}

export interface TerminalDriver {
    kind: "terminal";
    id: string;
    label: string;
    open(target: TerminalTarget): Promise<OpenResult>;
}

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Spawns one argv (never a shell); injected so tests never start a real app. */
export type ArgvRunner = (argv: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<RunResult>;
