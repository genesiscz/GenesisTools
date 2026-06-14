export type RedactType = "keys" | "tokens" | "emails" | "ips" | "paths" | "phones";

export const DEFAULT_TYPES = ["keys", "tokens", "emails", "ips", "paths"] as const satisfies readonly RedactType[];

export const ALL_TYPES = [
    "keys",
    "tokens",
    "emails",
    "ips",
    "paths",
    "phones",
] as const satisfies readonly RedactType[];

export interface Span {
    start: number;
    end: number;
    type: RedactType;
    value: string;
}

export interface RedactOptions {
    homeDir: string;
    types: readonly RedactType[];
}

export type Mapping = Record<string, string>;

export interface RedactResult {
    redacted: string;
    mapping: Mapping;
}

export interface SessionRecord {
    createdAt: string;
    types: readonly RedactType[];
    mapping: Mapping;
}
