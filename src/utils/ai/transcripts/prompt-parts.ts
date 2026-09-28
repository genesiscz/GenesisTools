import { isRecord } from "@genesiscz/utils/ai/usage/transcripts/parse-helpers";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { cleanTranscriptText } from "./clean-text";

/**
 * What the harness delivers into a running session as a user turn, never typed by the user: a peer's
 * message, a background task's result, and the marker Claude Code stores for an Esc. A handoff quoted a
 * whole teammate report as the session's goal, and "the last 2 prompts" spent one on an Esc marker.
 */
export const HARNESS_DELIVERY_PREFIXES = [
    "Another Claude session sent a message",
    "<teammate-message",
    "<task-notification>",
    "[SYSTEM NOTIFICATION",
    "[Request interrupted by user",
] as const;

/** The user's own words. `midTurn` when the harness delivered them while the agent was still working. */
export interface UserPromptPart {
    kind: "user";
    text: string;
    midTurn?: true;
}

/** A peer agent's message. `body` is markdown; a JSON payload is unwrapped to its text field. */
export interface TeammatePromptPart {
    kind: "teammate";
    from: string;
    color?: string;
    summary?: string;
    /** The JSON payload's `type` (`idle_notification`, `task_assignment`, …); absent for a plain-text message. */
    type?: string;
    body: string;
}

/** A background command or sub-agent that finished (or a goal check-in, which carries only a summary). */
export interface TaskPromptPart {
    kind: "task";
    id?: string;
    status?: string;
    summary?: string;
    outputFile?: string;
    /** A sub-agent's final report, as markdown. */
    result?: string;
}

/** The Esc marker: `[Request interrupted by user]`, `… for tool use]`. */
export interface InterruptPromptPart {
    kind: "interrupt";
    text: string;
}

/** A `<system-reminder>` or `[SYSTEM NOTIFICATION …]` the harness attached. */
export interface SystemPromptPart {
    kind: "system";
    text: string;
}

export type PromptPart = UserPromptPart | TeammatePromptPart | TaskPromptPart | InterruptPromptPart | SystemPromptPart;

const DELIVERY_HEADER = "Another Claude session sent a message:";
const MID_TURN = "The user sent a new message while you were working:";
/** The paragraph Claude Code appends after peer messages, telling the agent how far a peer's word goes. */
const PEER_NOTICE = "This came from another Claude session";
// Two wordings of the instruction Claude Code appends after a mid-turn message (2.1.2xx, then 2.1.28x).
const MID_TURN_TAIL =
    /\n\s*(?:IMPORTANT: After completing your current task, you MUST address the user's message above\.[^\n]*|This is how Claude Code surfaces messages the user sends mid-turn[^\n]*)\s*$/;
const INTERRUPT = /^\[(Request interrupted by user[^\]\n]*)\]/;
const TEAMMATE_OPEN = /^<teammate-message((?:\s+[\w-]+="[^"]*")*)\s*>/;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;
const TASK_FIELD = /<(task-id|tool-use-id|output-file|status|summary|note|result)>([\s\S]*?)<\/\1>/g;
/** Openers `readBlock` knows, besides `<teammate-message`, which must be followed by a space or `>`. */
const SEGMENT_OPENERS = [
    "<task-notification>",
    "<system-reminder>",
    "[Request interrupted by user",
    "[SYSTEM NOTIFICATION",
    DELIVERY_HEADER,
    MID_TURN,
    PEER_NOTICE,
];
/**
 * A harness segment only starts a line; the same words inside a sentence are the user's own. Built from
 * the openers above, so a marker `readBlock` recognises can never be missing here.
 */
const SEGMENT_START = new RegExp(
    `\\n[ \\t]*(?=<teammate-message[\\s>]|${SEGMENT_OPENERS.map((opener) => opener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g"
);
const QUICK_MARKERS = [
    "<teammate-message",
    "<task-notification>",
    "<system-reminder>",
    "[Request interrupted by user",
    "[SYSTEM NOTIFICATION",
    MID_TURN,
] as const;
/** JSON payload keys that say who and when, not what: a payload of only these has no body. */
const META_KEYS = new Set(["type", "from", "timestamp", "requestId", "paneId", "backendType", "idleReason", "summary"]);
const BODY_KEYS = ["result", "message", "content", "description", "reason", "text"] as const;
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" };

interface Block {
    part?: PromptPart;
    parts?: PromptPart[];
    end: number;
}

function decodeEntities(text: string): string {
    return text.replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}

function nextSegmentStart(raw: string, from: number): number {
    SEGMENT_START.lastIndex = Math.max(0, from - 1);
    const match = SEGMENT_START.exec(raw);
    return match ? match.index + match[0].length : raw.length;
}

function skipSpace(raw: string, at: number): number {
    let pos = at;
    while (pos < raw.length && /\s/.test(raw[pos] ?? "")) {
        pos += 1;
    }

    return pos;
}

function closedBlock(raw: string, at: number, open: string, tag: string): { inner: string; end: number } | null {
    const close = `</${tag}>`;
    const closeAt = raw.indexOf(close, at + open.length);
    if (closeAt < 0) {
        return null;
    }

    return { inner: raw.slice(at + open.length, closeAt), end: closeAt + close.length };
}

function midTurnText(segment: string): string {
    return cleanTranscriptText(segment.replace(MID_TURN_TAIL, ""));
}

function jsonObjectOf(body: string): Record<string, unknown> | null {
    if (!body.startsWith("{") || !body.endsWith("}")) {
        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(body, { strict: true });
        return isRecord(parsed) && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        logger.debug({ error }, "prompt-parts: a teammate body that looks like JSON is plain text");
        return null;
    }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}

function teammateBody(payload: Record<string, unknown>): string {
    const text = BODY_KEYS.map((key) => stringField(payload, key)).find((value) => value !== undefined);
    const failure = stringField(payload, "failureReason");
    const lines = [text, failure ? `**Failed:** ${failure}` : undefined].filter((line) => line !== undefined);
    if (lines.length > 0) {
        return lines.join("\n\n");
    }

    const rest = Object.fromEntries(Object.entries(payload).filter(([key]) => !META_KEYS.has(key)));
    if (Object.keys(rest).length === 0) {
        return "";
    }

    // A payload shape this parser does not know keeps every field, as JSON.
    return `\`\`\`json\n${SafeJSON.stringify(rest, null, 2)}\n\`\`\``;
}

function teammatePart(attributes: string, rawBody: string): TeammatePromptPart {
    const attrs: Record<string, string> = {};
    for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) {
        if (name && value !== undefined) {
            attrs[name] = decodeEntities(value);
        }
    }

    const body = rawBody.trim();
    const payload = jsonObjectOf(body);
    const from = attrs.teammate_id ?? (payload ? stringField(payload, "from") : undefined) ?? "teammate";
    const part: TeammatePromptPart = { kind: "teammate", from, body: payload ? teammateBody(payload) : body };
    const summary =
        attrs.summary ?? (payload ? (stringField(payload, "summary") ?? stringField(payload, "subject")) : undefined);
    const type = payload ? stringField(payload, "type") : undefined;

    if (attrs.color) {
        part.color = attrs.color;
    }

    if (summary) {
        part.summary = summary;
    }

    if (type) {
        part.type = type;
    }

    return part;
}

function taskPart(inner: string): TaskPromptPart {
    const fields: Record<string, string> = {};
    const leftover = inner
        .replace(TASK_FIELD, (_, name: string, value: string) => {
            fields[name] = decodeEntities(value.trim());
            return "";
        })
        .trim();
    const part: TaskPromptPart = { kind: "task" };
    const result = [fields.result, leftover ? decodeEntities(leftover) : undefined].filter(Boolean).join("\n\n");

    if (fields["task-id"]) {
        part.id = fields["task-id"];
    }

    if (fields.status) {
        part.status = fields.status;
    }

    if (fields.summary) {
        part.summary = fields.summary;
    }

    if (fields["output-file"]) {
        part.outputFile = fields["output-file"];
    }

    if (result) {
        part.result = result;
    }

    return part;
}

/** The harness segment that starts at `at`, or null when the text there is the user's own. */
function readBlock(raw: string, at: number): Block | null {
    if (raw.startsWith(DELIVERY_HEADER, at)) {
        // The header goes with the first message it introduces; before a broken one it is plain text.
        const next = skipSpace(raw, at + DELIVERY_HEADER.length);
        return raw.startsWith("<teammate-message", next) ? readBlock(raw, next) : null;
    }

    const interrupt = INTERRUPT.exec(raw.slice(at, at + 200));
    if (interrupt?.[1]) {
        return { part: { kind: "interrupt", text: interrupt[1] }, end: at + interrupt[0].length };
    }

    if (raw.startsWith("<teammate-message", at)) {
        const open = TEAMMATE_OPEN.exec(raw.slice(at, at + 2000));
        const block = open ? closedBlock(raw, at, open[0], "teammate-message") : null;
        return open && block ? { part: teammatePart(open[1] ?? "", block.inner), end: block.end } : null;
    }

    if (raw.startsWith("<task-notification>", at)) {
        const block = closedBlock(raw, at, "<task-notification>", "task-notification");
        return block ? { part: taskPart(block.inner), end: block.end } : null;
    }

    if (raw.startsWith("<system-reminder>", at)) {
        const block = closedBlock(raw, at, "<system-reminder>", "system-reminder");
        if (!block) {
            return null;
        }

        // A reminder can wrap a mid-turn message or a task result: those keep their own kind, and
        // whatever else it says is the reminder.
        return { parts: parseParts(block.inner, "system"), end: block.end };
    }

    if (raw.startsWith(PEER_NOTICE, at)) {
        // Only its own line: every notice Claude Code wrote is one line (all of them, measured over this
        // machine's sessions on 2026-09-28), so the next line, blank or not, is someone else's.
        const lineEnd = raw.indexOf("\n", at);
        const end = lineEnd < 0 ? raw.length : lineEnd;
        return { part: { kind: "system", text: raw.slice(at, end).trim() }, end };
    }

    if (raw.startsWith(MID_TURN, at) || raw.startsWith("[SYSTEM NOTIFICATION", at)) {
        const end = nextSegmentStart(raw, at + 1);
        const segment = raw.slice(at, end);
        const part: PromptPart = raw.startsWith(MID_TURN, at)
            ? { kind: "user", text: midTurnText(segment.slice(MID_TURN.length)), midTurn: true }
            : { kind: "system", text: decodeEntities(segment.trim()) };
        return { part, end };
    }

    return null;
}

/**
 * A prompt's text split into what the user typed and what the harness delivered: peer messages,
 * task results, Esc markers and reminders, in order. Text no rule claims is the user's, cleaned as
 * `cleanTranscriptText` cleans a prompt, so nothing is lost; an unclosed tag is plain text too.
 */
export function parsePromptParts(raw: string): PromptPart[] {
    return parseParts(raw, "user");
}

/** `plainAs: "system"` inside a reminder: text no rule claims is the reminder's, kept with its line breaks. */
function parseParts(raw: string, plainAs: "user" | "system"): PromptPart[] {
    const parts: PromptPart[] = [];
    let plain = "";
    let pos = 0;

    const flush = () => {
        const text = plainAs === "user" ? cleanTranscriptText(plain) : decodeEntities(plain.trim());
        if (text) {
            parts.push({ kind: plainAs, text });
        }

        plain = "";
    };

    while (pos < raw.length) {
        const at = skipSpace(raw, pos);
        if (at >= raw.length) {
            break;
        }

        const block = readBlock(raw, at);
        if (block) {
            flush();
            parts.push(...(block.parts ?? []), ...(block.part ? [block.part] : []));
            pos = block.end;
            continue;
        }

        const next = nextSegmentStart(raw, at + 1);
        plain += raw.slice(pos, next);
        pos = next;
    }

    flush();
    return parts.filter((part) => part.kind !== "user" || part.text.length > 0);
}

/**
 * The parts of a prompt that holds anything besides the user's own plain text, or undefined for an
 * ordinary prompt (the common case, so a transcript carries no parts for it).
 */
export function structuredPromptParts(raw: string): PromptPart[] | undefined {
    if (!QUICK_MARKERS.some((marker) => raw.includes(marker))) {
        return undefined;
    }

    const parts = parsePromptParts(raw);
    const plainOnly = parts.every((part) => part.kind === "user" && !part.midTurn);
    return plainOnly ? undefined : parts;
}

/** True when no part of the prompt is the user's own words. */
export function isHarnessDelivery(parts: readonly PromptPart[]): boolean {
    return parts.length > 0 && parts.every((part) => part.kind !== "user");
}

/**
 * A turn that only reports the harness's own background work (a task result, a goal check-in). It
 * asks nothing and answers nothing, unlike a peer's message, which can carry a worker's assignment
 * or the answer to its question. Such turns were invisible before prompt parts, and readers that
 * look for the last prompt skip them so they behave as they did.
 */
export function isTaskReport(parts: readonly PromptPart[] | undefined): boolean {
    if (!parts?.some((part) => part.kind === "task")) {
        return false;
    }

    return parts.every((part) => part.kind === "task" || part.kind === "system");
}
