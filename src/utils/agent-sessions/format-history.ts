import { SafeJSON } from "@genesiscz/utils/json";
import type { AgentSearchHit } from "./types";

export function formatHistoryMarkdown(hits: AgentSearchHit[], query?: string): string {
    const q = query ? `"${query}"` : "all";
    const lines = [`## Found ${hits.length} conversation${hits.length === 1 ? "" : "s"} matching ${q}`, ""];

    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const date = hit.mtime.toISOString().slice(0, 10);
        lines.push(`### ${i + 1}. ${hit.title}`);
        lines.push(`**Date:** ${date} | **Kind:** ${hit.kind} | **Session ID:** \`${hit.sessionId}\``);
        lines.push(`**Cwd:** \`${hit.cwd}\``);
        if (hit.matchedText) {
            lines.push("");
            lines.push(hit.matchedText.replace(/\n/g, " ").trim());
        }
        lines.push("");
    }

    return lines.join("\n");
}

export function formatHistoryJson(hits: AgentSearchHit[]): string {
    return `${SafeJSON.stringify(
        hits.map((hit) => ({
            kind: hit.kind,
            sessionId: hit.sessionId,
            title: hit.title,
            cwd: hit.cwd,
            mtime: hit.mtime.toISOString(),
            matchedText: hit.matchedText,
            filePath: hit.filePath,
        })),
        null,
        2
    )}\n`;
}
