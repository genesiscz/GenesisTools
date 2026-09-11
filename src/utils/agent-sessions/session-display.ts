import { cleanPromptText } from "@genesiscz/utils/ai/transcripts/clean-text";
import { formatClock, formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import type { TableSelectOptions } from "@genesiscz/utils/prompts/clack/table-select";
import { accent } from "@genesiscz/utils/prompts/clack/table-select";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import type { AgentSearchHit, AgentSession } from "./types";

/**
 * One indexed session as every session table, picker and candidate list reads it.
 *
 * This was `utils/claude/session-display.ts` and nothing in it was Claude-shaped, so the shared
 * resume path could not reach the rich picker without importing through a provider folder. The
 * optional fields below all existed already on Claude's own `DisplaySession`; they are declared
 * here so the shared builders can render them for codex and grok too.
 */
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
    created?: string;
    /** Friendly project name; `project` may hold the encoded transcript directory. */
    projectName?: string;
    sourceHome?: string;
    sourceKey?: string;
    filePath?: string;
    cwd?: string;
}

const NAME_COL_WIDTH = 56;
const DETAIL_LINE_WIDTH = 72;
const DETAIL_PROMPT_LINES = 6;
const PROMPT_PREVIEW_LEN = 60;
const AMBIGUOUS_ROWS_SHOWN = 20;

/** An indexed session in the display shape; a search hit carries its matched snippet across. */
export function toSessionDisplay(session: AgentSession | AgentSearchHit): SessionDisplayItem {
    const matchSnippet = "matchedText" in session ? session.matchedText : undefined;

    return {
        sessionId: session.sessionId,
        // A raw title can BE a harness block: `<command-name>/resume</command-name>` over several
        // lines, which reads as garbage in the picker and breaks the row it is printed in.
        name:
            cleanPromptText(session.title) ??
            cleanPromptText(session.summary) ??
            cleanPromptText(session.prompt)?.slice(0, PROMPT_PREVIEW_LEN) ??
            "(unnamed)",
        summary: session.summary ?? "",
        branch: session.gitBranch ?? "",
        project: session.projectDirectory ?? session.project ?? "",
        projectName: session.project,
        modified: session.mtime.toISOString(),
        created: session.createdAt?.toISOString(),
        source: matchSnippet ? "search" : "cache",
        firstPrompt: session.prompt ?? "",
        matchSnippet,
        sourceHome: session.sourceHome,
        sourceKey: session.sourceKey,
        filePath: session.filePath,
        cwd: session.cwd,
    };
}

/**
 * Outside a TTY there is no picker, so the candidates have to be readable enough to choose from.
 *
 * Print this BEFORE failing an ambiguous resume. The alternative, naming only the count, tells
 * the user that their query was too broad and nothing about which query would be narrow enough.
 */
export function printAmbiguousSessions(candidates: SessionDisplayItem[], shown = AMBIGUOUS_ROWS_SHOWN): void {
    const table = createBoxTable(["#", "SESSION ID", "NAME", "CREATED", "AGE", "LAST PROMPT", "PROJECT"]);

    for (const [index, candidate] of candidates.slice(0, shown).entries()) {
        const created = candidate.created ? new Date(candidate.created) : undefined;
        const modified = candidate.modified ? new Date(candidate.modified) : undefined;
        table.push([
            String(index + 1),
            candidate.sessionId,
            truncateDisplay(candidate.name, 40),
            created ? formatClock(created, { date: "short" }) : "—",
            created ? formatRelativeTime(created) : "—",
            modified ? formatRelativeTime(modified) : "—",
            truncateDisplay(candidate.projectName || candidate.project, 24),
        ]);
    }

    out.println(table.toString());

    if (candidates.length > shown) {
        out.println(pc.dim(`… and ${candidates.length - shown} more; narrow the query to see them.`));
    }
}

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

/**
 * A name may carry newlines (a pasted prompt, a harness block). Flattened first: a row that
 * stays one line is what keeps every column below it aligned.
 */
function truncateSession(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();

    if (flat.length <= max) {
        return flat;
    }

    return `${flat.slice(0, max - 1)}…`;
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

            // Where the transcript actually lives: the same session id can be indexed from
            // several homes, and the picker row alone cannot tell those copies apart.
            const detail = [
                ...buildDetailLines(s),
                ...(s.sourceHome ? [`Source home: ${s.sourceHome}`] : []),
                ...(s.filePath ? [`Source file: ${s.filePath}`] : []),
            ];

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
