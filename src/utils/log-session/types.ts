export type StreamOut = "stdout" | "stderr";

export interface JsonlLineRecord {
    type: "line";
    seq: number;
    out: StreamOut;
    ts: number;
    text: string;
}

export interface JsonlMetaRecord {
    type: "meta";
    session: string;
    command: string;
    mode: "pty" | "pipe";
    cwd: string;
    startedAt: string;
    pid?: number;
}

export interface JsonlExitRecord {
    type: "exit";
    code: number;
    durationMs: number;
    ts: string;
}

export type JsonlRecord = JsonlLineRecord | JsonlMetaRecord | JsonlExitRecord | Record<string, unknown>;

export interface SessionMetaBase {
    name: string;
    createdAt: number;
    lastActivityAt: number;
}
