import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { teamsRoot } from "@app/claude/lib/teams/discover";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sessionTeamName, unreadInbox } from "./team";
import type { AgentMail } from "./types";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(line: string): JsonRecord | null {
    try {
        const value: unknown = SafeJSON.parse(line, { strict: true });
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

const TEAMMATE_MESSAGE = /<teammate-message\s+teammate_id="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>/g;

/** The prompt text a user or attachment record carries. */
function recordText(record: JsonRecord): string {
    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .filter((part): part is JsonRecord => isRecord(part) && part.type === "text")
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("\n");
    }

    const attachment = isRecord(record.attachment) ? record.attachment : null;
    for (const key of ["prompt", "content"] as const) {
        if (typeof attachment?.[key] === "string") {
            return attachment[key];
        }
    }

    return "";
}

function messageText(value: unknown): string {
    return typeof value === "string" ? value : SafeJSON.stringify(value);
}

/**
 * The mail of one teammate, read from its own transcript: `<teammate-message>` records it
 * received (with the time they reached it), the SendMessage calls it made, and its inbox entries
 * Claude Code has not delivered yet. The gap between an inbox entry and its arrival is the
 * "mail waits for the turn end" delay.
 */
export function readAgentMail(transcript: string, unread: AgentMail["unread"]): AgentMail {
    const mail: AgentMail = { received: [], sent: [], unread };
    let raw: string;
    try {
        raw = readFileSync(transcript, "utf8");
    } catch (error) {
        logger.debug({ error, transcript }, "[hub agents] unreadable teammate transcript");
        return mail;
    }

    for (const line of raw.split("\n")) {
        const hasMessage = line.includes("<teammate-message");
        const hasSend = line.includes('"name":"SendMessage"');
        if (!hasMessage && !hasSend) {
            continue;
        }

        const record = parse(line);
        if (!record) {
            continue;
        }

        const at = typeof record.timestamp === "string" ? record.timestamp : null;
        if (hasMessage && record.type !== "assistant") {
            for (const match of recordText(record).matchAll(TEAMMATE_MESSAGE)) {
                mail.received.push({ from: match[1], at, text: match[2] });
            }
        }

        const message = isRecord(record.message) ? record.message : null;
        if (hasSend && record.type === "assistant" && Array.isArray(message?.content)) {
            for (const part of message.content) {
                if (isRecord(part) && part.type === "tool_use" && part.name === "SendMessage" && isRecord(part.input)) {
                    const to = typeof part.input.to === "string" ? part.input.to : "unknown";
                    mail.sent.push({ to, at, text: messageText(part.input.message ?? part.input.summary ?? "") });
                }
            }
        }
    }

    return mail;
}

export interface AgentMailOptions {
    /** The lead session (id or id prefix). */
    session: string;
    /** The teammate's agent id (`aE-sharedkit-4743…`) or its `agent-` file name. A display name is not looked up. */
    agent: string;
    teamsRoot?: string;
}

function readMetaName(path: string): { name: string | null; teamName: string | null } {
    try {
        const meta: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        return {
            name: isRecord(meta) && typeof meta.name === "string" ? meta.name : null,
            teamName: isRecord(meta) && typeof meta.teamName === "string" ? meta.teamName : null,
        };
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] no teammate meta");
        return { name: null, teamName: null };
    }
}

export async function agentMail(options: AgentMailOptions): Promise<AgentMail> {
    const parent = await resolveTranscript(options.session, {}, "claude");
    const dir = join(dirname(parent.filePath), basename(parent.filePath, ".jsonl"), "subagents");
    const agentId = options.agent.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    const transcript = join(dir, `agent-${agentId}.jsonl`);
    if (!existsSync(transcript)) {
        throw new Error(`No agent ${agentId} under session ${parent.sessionId} (${dir})`);
    }

    const meta = readMetaName(join(dir, `agent-${agentId}.meta.json`));
    const root = options.teamsRoot ?? teamsRoot();
    const team = meta.teamName ?? sessionTeamName(parent.sessionId);
    const unread = meta.name
        ? unreadInbox(root, team, meta.name).map((entry) => ({
              from: entry.from,
              at: entry.timestamp,
              text: entry.text,
          }))
        : [];
    logger.debug({ transcript, team, name: meta.name }, "[hub agents] reading teammate mail");
    return readAgentMail(transcript, unread);
}
