import { formatSessionAge } from "@genesiscz/utils/claude/session-display";
import { truncateText } from "@genesiscz/utils/string";
import type { SearchResult } from "./types";

export const HISTORY_TABLE_HEADERS = ["ID", "PROJECT", "TITLE", "BRANCH", "DATE", "STATUS"] as const;

export function historyTablePlainRow(result: SearchResult): string[] {
    const title = result.customTitle || result.summary || "(unnamed)";
    const project = result.project.trim();

    return [
        result.sessionId,
        project ? truncateText(project, 18) : "—",
        truncateText(title, 36),
        result.gitBranch ? truncateText(result.gitBranch, 18) : "—",
        formatSessionAge(result.timestamp.toISOString()),
        result.isSubagent ? "agent" : "main",
    ];
}
