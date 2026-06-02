export type RedactType = "keys" | "tokens" | "emails" | "ips" | "paths" | "phones";

export const DEFAULT_TYPES: RedactType[] = ["keys", "tokens", "emails", "ips", "paths"];

export const ALL_TYPES: RedactType[] = ["keys", "tokens", "emails", "ips", "paths", "phones"];

export interface Span {
    start: number;
    end: number;
    type: RedactType;
    value: string;
}

export interface RedactOptions {
    homeDir: string;
    types: RedactType[];
}

export type Mapping = Record<string, string>;

export interface RedactResult {
    redacted: string;
    mapping: Mapping;
}

export interface SessionRecord {
    createdAt: string;
    types: RedactType[];
    mapping: Mapping;
}
