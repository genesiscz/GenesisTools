import { formatDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { truncateText } from "@genesiscz/utils/string";
import type { LoginReadyEvent, LoginTimeoutEvent } from "./login-io";
import type { FeedEvent, MessageEvent } from "./types";

/** How much of a message body the headline repeats. The JSON line after it always carries the whole body. */
const HEADLINE_BODY_MAX = 200;

export type MonitorEvent = FeedEvent | LoginReadyEvent | LoginTimeoutEvent;

/** agent_id → agent_name. A name is unique in its session, so it identifies an agent as well as the id does. */
export type AgentNames = Map<string, string>;

export interface BatchPosition {
    index: number;
    total: number;
}

/**
 * One event for a Monitor stream: a headline that reads in one terminal row, then the same JSON line `--format json`
 * prints. Claude Code draws the first line of an event as its row and gives the model every line.
 */
export function formatEventMonitor(event: MonitorEvent, names: AgentNames, position?: BatchPosition): string {
    // Lines written together arrive as one Monitor event whose row shows only the first headline, so a batch says
    // how many events it carries.
    const prefix = position && position.total > 1 ? `[${position.index}/${position.total}] ` : "";
    return `${prefix}${oneLine(monitorHeadline(event, names))}\n${eventJsonLine(event)}`;
}

/**
 * The JSON line for one event. A message leads with `body`, then `from_agent_name`, then every other key in its
 * usual order: a Monitor notification shows only the first keys of a long line, and `type` and the sender id used to
 * fill that space and hide the message (2026-10-13).
 */
export function eventJsonLine(event: MonitorEvent): string {
    if (event.type !== "message") {
        return SafeJSON.stringify(event, { strict: true });
    }

    const { body, from_agent_name, ...rest } = event;
    return SafeJSON.stringify({ body, from_agent_name, ...rest }, { strict: true });
}

export function learnAgentNames(names: AgentNames, event: FeedEvent): void {
    if (event.type === "message") {
        names.set(event.from_agent_id, event.from_agent_name);
        return;
    }

    if ("agent_name" in event && event.agent_id) {
        names.set(event.agent_id, event.agent_name);
    }
}

export function agentNamesFrom(events: readonly FeedEvent[]): AgentNames {
    const names: AgentNames = new Map();

    for (const event of events) {
        learnAgentNames(names, event);
    }

    return names;
}

export function monitorHeadline(event: MonitorEvent, names: AgentNames): string {
    switch (event.type) {
        case "message":
            return messageHeadline(event, names);
        case "ready":
            return `ready: ${event.agent_name} is listening (${event.mode}${event.is_main ? ", main" : ""}) · session ${event.session}`;
        case "timeout":
            return `timeout: no mail for ${event.agent_name} after ${formatDuration(event.waited_ms)}`;
        case "agent_joined":
            return `joined: ${event.agent_name} · present: ${nameList(event.present, "nobody else")}`;
        case "agent_left": {
            const note = event.note ? `: ${oneLine(event.note)}` : "";
            return `left: ${event.agent_name} (${event.reason}${note}) · remaining: ${nameList(event.remaining, "nobody")}`;
        }
        case "registered": {
            const id = event.agent_id ? ` as ${event.agent_id}` : "";
            const traits = [
                event.is_main ? "main" : null,
                event.role ? `role ${event.role}` : null,
                event.awaiting_login ? "awaiting login" : null,
            ].filter((trait) => trait !== null);
            return `registered: ${event.agent_name}${id}${traits.length > 0 ? ` (${traits.join(", ")})` : ""}`;
        }
        case "logged_in":
            return `logged in: ${event.agent_name} (${event.mode})`;
        case "logged_out":
            return `logged out: ${names.get(event.agent_id) ?? event.agent_id} (${event.reason})`;
        case "stale_lock_reaped": {
            const pid = event.pid === undefined ? "" : `, pid ${event.pid}`;
            return `stale lock reaped: ${event.lock} (${event.reason}${pid})`;
        }
    }
}

function messageHeadline(event: MessageEvent, names: AgentNames): string {
    const to =
        event.to_agent_ids.length === 0
            ? "(broadcast)"
            : event.to_agent_ids.map((id) => names.get(id) ?? id).join(", ");
    const route = `${event.from_agent_name} → ${to}${event.private ? " (private)" : ""}`;

    if (!event.in_reply_to) {
        return `message: ${route}: ${bodyPreview(event.body)}`;
    }

    if (!event.body) {
        return `ack: ${route}, re ${event.in_reply_to}`;
    }

    return `reply: ${route}, re ${event.in_reply_to}: ${bodyPreview(event.body)}`;
}

function bodyPreview(body: string): string {
    const flat = oneLine(body);
    return flat === "" ? "(empty body)" : truncateText(flat, HEADLINE_BODY_MAX);
}

/** A row is one line: line breaks show as ⏎, and other control characters (tabs, escapes) become spaces. */
function oneLine(text: string): string {
    return text
        .replace(/\r\n|[\n\r\p{Zl}\p{Zp}]/gu, " ⏎ ")
        .replace(/\p{Cc}/gu, " ")
        .trim();
}

function nameList(agentNames: readonly string[], empty: string): string {
    return agentNames.length > 0 ? agentNames.join(", ") : empty;
}
