import type { TableSelectOptions } from "@genesiscz/utils/prompts/clack/table-select";
import { accent } from "@genesiscz/utils/prompts/clack/table-select";
import { formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import pc from "picocolors";

export interface SessionDisplayItem {
    sessionId: string;
    name: string;
    summary: string;
    branch: string;
    project: string;
    modified: string;
    source: "cache" | "search";
    firstPrompt: string;
    matchSnippet?: string;
}

const NAME_COL_WIDTH = 42;
const DETAIL_LINE_WIDTH = 72;
const DETAIL_PROMPT_LINES = 6;

export function formatSessionAge(iso: string): string {
    if (!iso) {
        return pc.dim("—");
    }

    const ms = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(ms / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    let text: string;
    if (minutes < 1) {
        text = "now";
    } else if (minutes < 60) {
        text = `${minutes}m`;
    } else if (hours < 48) {
        text = `${hours}h`;
    } else {
        text = `${days}d`;
    }

    if (minutes < 30) {
        return pc.green(text);
    }

    if (hours < 6) {
        return pc.yellow(text);
    }

    return pc.dim(text);
}

export function formatSessionBadge(source: "cache" | "search", isActive = false): string {
    if (isActive) {
        return pc.green("●");
    }

    if (source === "search") {
        return pc.yellow("●");
    }

    return pc.dim("●");
}

function truncateSession(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }

    return `${text.slice(0, max - 1)}…`;
}

function sessionSnippet(s: SessionDisplayItem): string {
    if (s.matchSnippet) {
        return s.matchSnippet.replace(/\n/g, " ").trim();
    }

    const nameNorm = s.name.toLowerCase().trim();

    if (s.summary && s.summary.toLowerCase().trim() !== nameNorm) {
        return s.summary;
    }

    if (s.firstPrompt && s.firstPrompt.slice(0, 60).toLowerCase().trim() !== nameNorm) {
        return s.firstPrompt;
    }

    return "";
}

function wrapText(text: string, width: number, maxLines: number): string[] {
    const clean = text.replace(/\n+/g, " ").trim();

    if (!clean) {
        return [];
    }

    const lines: string[] = [];
    let remaining = clean;

    while (remaining.length > 0 && lines.length < maxLines) {
        if (remaining.length <= width) {
            lines.push(remaining);
            break;
        }

        let breakAt = remaining.lastIndexOf(" ", width);

        if (breakAt <= 0) {
            breakAt = width;
        }

        lines.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
    }

    if (remaining.length > 0 && lines.length === maxLines) {
        const last = lines[maxLines - 1];
        lines[maxLines - 1] = `${last.slice(0, last.length - 1)}…`;
    }

    return lines;
}

function buildDetailLines(s: SessionDisplayItem): string[] {
    const header = [
        accent(s.sessionId.slice(0, 8)),
        s.project ? pc.blue(s.project) : "",
        s.source === "search" ? pc.yellow("[search]") : "",
    ]
        .filter(Boolean)
        .join(pc.dim(" · "));

    const lines: string[] = [header];

    const promptText = sessionSnippet(s) || s.firstPrompt;

    if (promptText) {
        const wrapped = wrapText(promptText, DETAIL_LINE_WIDTH, DETAIL_PROMPT_LINES);

        for (const line of wrapped) {
            lines.push(pc.dim(line));
        }
    }

    // Pad to fixed height so the detail zone doesn't jump
    while (lines.length < DETAIL_PROMPT_LINES + 1) {
        lines.push("");
    }

    return lines;
}

export function buildSessionTableOpts(
    sessions: SessionDisplayItem[],
    opts: { message: string; query?: string }
): TableSelectOptions<SessionDisplayItem> {
    const hasMultipleProjects = new Set(sessions.map((s) => s.project).filter(Boolean)).size > 1;

    const columns = [
        { label: "NAME", minWidth: NAME_COL_WIDTH },
        { label: "BRANCH", minWidth: 10 },
        ...(hasMultipleProjects ? [{ label: "PROJECT", minWidth: 8 }] : []),
        { label: "AGE", align: "right" as const, minWidth: 4 },
    ];

    return {
        message: opts.message,
        hint: opts.query ? `matching "${opts.query}"` : undefined,
        columns,
        rows: sessions.map((s) => {
            const cells = [
                truncateSession(s.name, NAME_COL_WIDTH),
                s.branch ? pc.magenta(truncateSession(s.branch, 18)) : pc.dim("—"),
                ...(hasMultipleProjects ? [s.project ? pc.blue(truncateSession(s.project, 14)) : pc.dim("—")] : []),
                formatSessionAge(s.modified),
            ];

            const detail = buildDetailLines(s);

            return {
                value: s,
                badge: formatSessionBadge(s.source),
                cells,
                detail,
            };
        }),
        formatSubmitted: (row) => row.value.name,
    };
}

export function renderSessionListHeader(title: string, subtitle: string): void {
    renderCliHeader(title, subtitle);
}

export { formatDotStatus, renderCliHeader };
