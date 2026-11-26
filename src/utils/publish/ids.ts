import { randomBytes } from "node:crypto";

export const KIND_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const SNAPSHOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const API_SEGMENT = "_api";

export function isSnapshotId(value: string): boolean {
    return SNAPSHOT_ID_RE.test(value) && value !== API_SEGMENT;
}

export function newSnapshotId(): string {
    return randomBytes(12).toString("base64url");
}

export function originOf(url: string): string {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Expected an HTTP or HTTPS URL");
    }

    return parsed.origin;
}
