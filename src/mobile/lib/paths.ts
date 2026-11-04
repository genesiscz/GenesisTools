import { toolDataDir } from "@genesiscz/utils/storage/root";

/** A file-safe local time stamp for a run folder: `2026-11-04T21-05-33`. */
export function stamp(date = new Date()): string {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** `~/.genesis-tools/mobile/runs/<time>`: one folder per e2e run, capture or screen read. */
export function runDirFor(kind: "runs" | "captures", date = new Date()): string {
    return toolDataDir("mobile", kind, stamp(date));
}
