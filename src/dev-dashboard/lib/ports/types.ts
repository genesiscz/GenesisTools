export type PortVisibility = "normal" | "system" | "junk";

/** Content/service kind after (or without) HTTP probe. */
export type PortKind = "web" | "api" | "genesis-tools" | "other";

export type PortProbeStatus = "pending" | "done" | "skipped";

export interface PortInfo {
    port: number;
    pid: number;
    /** Short process name (basename of argv0, or lsof's truncated COMMAND). */
    command: string;
    address: string;
    proto: "tcp4" | "tcp6";
    /** Full argv from `ps` — always resolved when available (not only for generic runtimes). */
    fullCommand?: string;
    /** Friendly display name (Cursor workspace, package.json name, dashboard registry, …). */
    title?: string;
    /** Process working directory. */
    cwd?: string;
    /** Process start time as ISO string (from `ps` lstart). */
    startedAt?: string;
    /**
     * True when an HTTP probe returned HTML (or a known web dashboard answered).
     * Kept for backward compat with selectWebapps; prefer `kind === "web"`.
     */
    isWebapp?: boolean;
    /** Set after classify; genesis-tools can be known before HTTP from registry+path verify. */
    kind?: PortKind;
    probeStatus?: PortProbeStatus;
    /** system = macOS daemons; junk = IDE/terminal ephemeral listeners. Hidden by default. */
    visibility?: PortVisibility;
    /** True when this port matches the GenesisTools dashboard registry AND process path/cmd verifies. */
    isGenesisTools?: boolean;
}

export interface PortsResult {
    lsofAvailable: boolean;
    ports: PortInfo[];
    /** Epoch ms of this scan — stable across classify merges so the UI SSE effect doesn't re-fire. */
    scannedAt: number;
}

export interface KillPortResult {
    ok: boolean;
    killed: boolean;
    reason?: string;
}

/** One SSE frame from `/api/ports/classify`. */
export type PortsClassifyEvent =
    | { type: "batch"; ports: PortInfo[] }
    | { type: "done"; classified: number }
    | { type: "error"; message: string };
