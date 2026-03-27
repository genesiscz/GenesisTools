import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ClaudeSessionFormatter } from "@app/utils/claude/ClaudeSessionFormatter";
import { IncludeSpec } from "@app/utils/claude/cli/dsl";
import { ClaudeSession } from "@app/utils/claude/session";
import type { SessionInfo } from "@app/utils/claude/session.types";
import { extractUserText, readHeadTailLines } from "@app/utils/claude/session.utils";
import type {
    AssistantMessage,
    AssistantMessageContent,
    ConversationMessage,
    UserMessage,
} from "@app/utils/claude/types";
import { suggestCommand } from "@app/utils/cli/executor";
import { formatRelativeTime } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { truncateText } from "@app/utils/string";
import pc from "picocolors";

const STATUSLINE_DIR = resolve(homedir(), ".claude", "statusline");
const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000;
const LIST_LIMIT = 15;

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ListSessionsOptions {
    level: 1 | 2;
    project?: string;
    colors: boolean;
}

/**
 * Get session IDs that are currently active (statusline mtime < 15 min).
 */
export function getActiveSessionIds(): Set<string> {
    const result = new Set<string>();

    if (!existsSync(STATUSLINE_DIR)) {
        return result;
    }

    try {
        for (const f of readdirSync(STATUSLINE_DIR)) {
            if (!f.startsWith("statusline.") || !f.endsWith(".state")) {
                continue;
            }

            const sessionId = f.replace("statusline.", "").replace(".state", "");
            const mtime = statSync(resolve(STATUSLINE_DIR, f)).mtimeMs;

            if (Date.now() - mtime < ACTIVE_THRESHOLD_MS) {
                result.add(sessionId);
            }
        }
    } catch {
        // Ignore filesystem errors
    }

    return result;
}

/**
 * Render the full session list (invoked by -l / -ll).
 */
export async function renderSessionList(options: ListSessionsOptions): Promise<void> {
    const sessions = await ClaudeSession.findSessions({
        project: options.project,
        limit: LIST_LIMIT,
    });

    if (sessions.length === 0) {
        console.log(pc.dim("No sessions found."));
        return;
    }

    const activeIds = getActiveSessionIds();
    sortByRecency(sessions);
    printSuggestHeader(sessions[0], options);

    for (const session of sessions) {
        if (options.level === 1) {
            await renderCompactSession(session, activeIds, options);
        } else {
            await renderVerboseSession(session, activeIds, options);
        }
    }
}

/**
 * Render a filtered list of active sessions only (for 2+ active auto-select).
 */
export async function renderActiveSessionList(
    activeSessions: SessionInfo[],
    activeIds: Set<string>,
    options: ListSessionsOptions
): Promise<void> {
    if (activeSessions.length === 0) {
        return;
    }

    sortByRecency(activeSessions);

    console.log(
        options.colors
            ? pc.yellow(`⚠ ${activeSessions.length} active sessions — pick one:`)
            : `⚠ ${activeSessions.length} active sessions — pick one:`
    );
    console.log();

    printSuggestHeader(activeSessions[0], options);

    for (const session of activeSessions) {
        await renderCompactSession(session, activeIds, options);
    }
}

// ─── Compact List (-l) ──────────────────────────────────────────────────────

async function renderCompactSession(
    session: SessionInfo,
    activeIds: Set<string>,
    options: ListSessionsOptions
): Promise<void> {
    const c = options.colors;
    const isActive = session.sessionId ? activeIds.has(session.sessionId) : false;
    const shortId = (session.sessionId ?? "unknown").slice(0, 8);

    const icon = isActive ? "🟢 " : "   ";
    const displayTime = session.lastTimestamp ?? session.startDate;
    const timeStr = displayTime ? formatRelativeTime(displayTime, { compact: true }) : "?";
    const branch = session.gitBranch ?? "";

    const header = c
        ? `${icon}${pc.bold(pc.white(shortId))}  ${pc.dim(timeStr.padEnd(8))} ${pc.cyan(branch)}`
        : `${icon}${shortId}  ${timeStr.padEnd(8)} ${branch}`;
    console.log(header);

    const preview = await extractSessionPreview(session.filePath);

    if (preview.lastUserMessage) {
        const collapsed = preview.lastUserMessage.replace(/\n+/g, " ");
        const truncated = truncateText(collapsed, 120);
        console.log(c ? `   ${pc.dim("›")} ${pc.green(truncated)}` : `   › ${truncated}`);
    }

    for (const excerpt of preview.assistantExcerpts) {
        const collapsed = excerpt.replace(/\n+/g, " ");
        const truncated = truncateText(collapsed, 200);
        console.log(c ? `   ${pc.dim("│")} ${truncated}` : `   │ ${truncated}`);
    }

    console.log();
}

// ─── Verbose List (-ll) ─────────────────────────────────────────────────────

async function renderVerboseSession(
    session: SessionInfo,
    activeIds: Set<string>,
    options: ListSessionsOptions
): Promise<void> {
    const c = options.colors;
    const isActive = session.sessionId ? activeIds.has(session.sessionId) : false;
    const shortId = (session.sessionId ?? "unknown").slice(0, 8);

    const icon = isActive ? "🟢 " : "   ";
    const displayTime = session.lastTimestamp ?? session.startDate;
    const timeStr = displayTime ? formatRelativeTime(displayTime, { compact: true }) : "?";
    const branch = session.gitBranch ?? "";

    const header = c
        ? `${icon}${pc.bold(pc.white(shortId))}  ${pc.dim(timeStr.padEnd(8))} ${pc.cyan(branch)}`
        : `${icon}${shortId}  ${timeStr.padEnd(8)} ${branch}`;
    console.log(header);

    const records = await extractTailRecords(session.filePath, 100);

    const displayable = records.filter(
        (r) => r.type === "user" || r.type === "assistant" || r.type === "subagent" || r.type === "progress"
    );
    const lastRecords = displayable.slice(-8);

    if (lastRecords.length === 0) {
        console.log(c ? pc.dim("   (no displayable messages)") : "   (no displayable messages)");
        console.log();
        return;
    }

    const formatter = new ClaudeSessionFormatter({
        includeSpec: IncludeSpec.defaults(),
        colors: c,
        mode: "mini",
        actorIcons: true,
        border: false,
        maxCharsPerMessage: 200,
        indent: "   ",
        output: (line) => console.log(line),
    });

    for (const record of lastRecords) {
        formatter.format(record);
    }

    formatter.closeAgentSection();
    console.log();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface SessionPreview {
    lastUserMessage: string | null;
    assistantExcerpts: string[];
}

async function extractSessionPreview(filePath: string): Promise<SessionPreview> {
    const lines = await readHeadTailLines(filePath, 0, 50);
    let lastUserMessage: string | null = null;
    const assistantExcerpts: string[] = [];

    for (const line of lines) {
        try {
            const obj = SafeJSON.parse(line) as Record<string, unknown>;

            if (!obj || typeof obj.type !== "string") {
                continue;
            }

            if (obj.type === "user") {
                const msg = obj as unknown as UserMessage;

                if (msg.isMeta) {
                    continue;
                }

                const text = extractUserText(msg.message?.content ?? "");

                if (text.trim()) {
                    lastUserMessage = text.trim();
                }
            }

            if (obj.type === "assistant" || obj.type === "A") {
                const content =
                    obj.type === "assistant"
                        ? (obj as unknown as AssistantMessage).message?.content
                        : ((obj as Record<string, unknown>).message as AssistantMessageContent | undefined)?.content;

                if (!Array.isArray(content)) {
                    continue;
                }

                for (const block of content) {
                    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                        assistantExcerpts.push(block.text.trim());
                    }
                }
            }
        } catch {
            // Skip unparseable lines
        }
    }

    return {
        lastUserMessage,
        assistantExcerpts: assistantExcerpts.slice(-5),
    };
}

async function extractTailRecords(filePath: string, count: number): Promise<ConversationMessage[]> {
    const lines = await readHeadTailLines(filePath, 0, count);
    const records: ConversationMessage[] = [];

    for (const line of lines) {
        try {
            const obj = SafeJSON.parse(line) as ConversationMessage;

            if (obj && typeof obj.type === "string") {
                records.push(obj);
            }
        } catch {
            // Skip
        }
    }

    return records;
}

function sortByRecency(sessions: SessionInfo[]): void {
    sessions.sort((a, b) => {
        const ta = a.lastTimestamp?.getTime() ?? a.startDate?.getTime() ?? 0;
        const tb = b.lastTimestamp?.getTime() ?? b.startDate?.getTime() ?? 0;
        return tb - ta;
    });
}

function printSuggestHeader(firstSession: SessionInfo, options: ListSessionsOptions): void {
    if (!firstSession.sessionId) {
        return;
    }

    const id = firstSession.sessionId.slice(0, 8);
    const hint = suggestCommand("tools claude", {
        replaceCommand: ["tail", id],
        keepFlags: ["-p", "--project"],
    });

    if (options.colors) {
        console.log(`  ${pc.dim("┌")} ${pc.cyan(hint)}`);
        console.log(`  ${pc.dim("└")}`);
    } else {
        console.log(`  ┌ ${hint}`);
        console.log("  └");
    }

    console.log();
}
