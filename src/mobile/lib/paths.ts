import { toolDataDir } from "@genesiscz/utils/storage/root";

/** A file-safe local time stamp for a run folder: `2026-11-04T21-05-33`. */
export function stamp(date = new Date()): string {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** `~/.genesis-tools/mobile/<kind>/<project>/<time>`: one folder per capture or tour. */
export function runDirFor(kind: "captures" | "tours", projectId: string, date = new Date()): string {
    return toolDataDir("mobile", kind, projectId, stamp(date));
}
