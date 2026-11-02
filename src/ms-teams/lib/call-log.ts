import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { asRecord } from "./ingest-parse";
import type { CallLogEvent } from "./types";

const log = logger.scoped("ms-teams").log;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PARTICIPANT_RE = new RegExp(
    `^callingParticipantService: participant (added|removed): (\\S+?),[\\s\\S]*?\\[callId=(${UUID})\\]`,
    "i"
);
const SELF_STATE_RE = new RegExp(`callingService\\.onCallStateChanged: callId = (${UUID}) to state = (\\w+)`, "i");
const THREAD_LINK_RE = new RegExp(
    `\\b(?:callId|call)[=: ]+(${UUID}),?\\s*(?:conversationId|threadId)[=: ]+(19:[^,\\s\\]]+@thread\\.(?:v2|skype|tacv2))`,
    "i"
);

/** Parse one web-client log line into an attendance fact, or null when it carries none. */
export function parseCallLogMessage(message: string, at: number): CallLogEvent | null {
    const participant = PARTICIPANT_RE.exec(message);

    if (participant) {
        const kind = participant[1].toLowerCase() === "added" ? "participant-added" : "participant-removed";
        return { kind, callId: participant[3].toLowerCase(), at, mri: participant[2] };
    }

    const selfState = SELF_STATE_RE.exec(message);

    if (selfState) {
        return { kind: "self-state", callId: selfState[1].toLowerCase(), at, state: selfState[2] };
    }

    const link = THREAD_LINK_RE.exec(message);

    if (link) {
        return { kind: "thread-link", callId: link[1].toLowerCase(), at, threadId: link[2] };
    }

    return null;
}

/** Parse one log file body (`{"logsArray":[{message,timeStamp}]}`). */
export function parseCallLogFile(text: string): CallLogEvent[] {
    if (!text.includes("callId")) {
        return [];
    }

    const root = asRecord(SafeJSON.parse(text, { strict: true }));
    const lines = Array.isArray(root?.logsArray) ? root.logsArray : [];
    const events: CallLogEvent[] = [];

    for (const raw of lines) {
        const line = asRecord(raw);
        const message = typeof line?.message === "string" ? line.message : null;
        const at = typeof line?.timeStamp === "string" ? Date.parse(line.timeStamp) : Number.NaN;

        if (!message || Number.isNaN(at)) {
            continue;
        }

        const event = parseCallLogMessage(message, at);

        if (event) {
            events.push(event);
        }
    }

    return events;
}

export function callLogEventKey(event: CallLogEvent): string {
    return `${event.callId}|${event.at}|${event.kind}|${callLogEventSubject(event)}`;
}

export function callLogEventSubject(event: CallLogEvent): string {
    switch (event.kind) {
        case "participant-added":
        case "participant-removed":
            return event.mri;
        case "self-state":
            return event.state;
        case "thread-link":
            return event.threadId;
    }
}

/**
 * Read every attendance fact from the Teams web-client log under the WebView file system. Read-only. The log
 * rotates within about a day, so `sync` stores what it finds.
 */
export function readCallLogEvents(root: string): CallLogEvent[] {
    if (!existsSync(root)) {
        log.debug({ root }, "[ms-teams] no web-client log directory");
        return [];
    }

    const seen = new Set<string>();
    const events: CallLogEvent[] = [];
    let files = 0;

    for (const path of listFiles(root)) {
        let text: string;

        try {
            text = readFileSync(path, "utf8");
        } catch (err) {
            log.debug({ err, path }, "[ms-teams] skipped an unreadable web-client log file");
            continue;
        }

        let parsed: CallLogEvent[];

        try {
            parsed = parseCallLogFile(text);
        } catch (err) {
            log.debug(
                { err, path },
                "[ms-teams] skipped a web-client log file that is not JSON (Teams may be writing it)"
            );
            continue;
        }

        files++;

        for (const event of parsed) {
            const key = callLogEventKey(event);

            if (!seen.has(key)) {
                seen.add(key);
                events.push(event);
            }
        }
    }

    events.sort((a, b) => a.at - b.at);
    log.debug({ root, files, events: events.length }, "[ms-teams] read web-client call log");

    return events;
}

function listFiles(dir: string): string[] {
    const out: string[] = [];

    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        let isDir: boolean;

        try {
            isDir = statSync(path).isDirectory();
        } catch (err) {
            log.debug({ err, path }, "[ms-teams] skipped a web-client log entry that vanished");
            continue;
        }

        if (isDir) {
            out.push(...listFiles(path));
        } else if (!name.startsWith(".") && name !== "LOG" && !name.endsWith(".ldb") && !name.endsWith(".log")) {
            out.push(path);
        }
    }

    return out;
}
