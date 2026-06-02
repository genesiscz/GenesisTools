import type { EnvDiff } from "./diff";

export interface BuildSyncedContentArgs {
    actualContent: string;
    diff: EnvDiff;
    now: Date;
}

export function buildSyncedContent({ actualContent, diff, now }: BuildSyncedContentArgs): string {
    if (diff.missing.length === 0) {
        return actualContent;
    }

    const base = actualContent.endsWith("\n") || actualContent.length === 0 ? actualContent : `${actualContent}\n`;
    const header = `\n# --- synced by tools envdiff @ ${now.toISOString()} ---\n`;
    const lines = diff.missing.map((entry) => `${entry.key}=${entry.exampleValue}`).join("\n");
    return `${base}${header}${lines}\n`;
}
