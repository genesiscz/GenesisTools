import type { EnvDiff } from "./diff";

export interface BuildSyncedContentArgs {
    actualContent: string;
    diff: EnvDiff;
    now: Date;
}

function formatValue(val: string): string {
    if (/[\s#"'\\\n]/.test(val)) {
        return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }

    return val;
}

export function buildSyncedContent({ actualContent, diff, now }: BuildSyncedContentArgs): string {
    if (diff.missing.length === 0) {
        return actualContent;
    }

    const base = actualContent.endsWith("\n") || actualContent.length === 0 ? actualContent : `${actualContent}\n`;
    const prefix = actualContent.length === 0 ? "" : "\n";
    const header = `${prefix}# --- synced by tools envdiff @ ${now.toISOString()} ---\n`;
    const lines = diff.missing.map((entry) => `${entry.key}=${formatValue(entry.exampleValue)}`).join("\n");
    return `${base}${header}${lines}\n`;
}
