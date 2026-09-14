import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { AskForm, PendingEvent, PendingEventKind } from "./types";

/**
 * Lifecycle events are appended to a day-stamped JSONL, exactly like the Q→A log and the
 * handoff log. The dashboard tails the file, so a form created by a CLI process in another
 * terminal reaches the browser with no shared memory and no daemon between them.
 */
export function pendingEventDir(base?: string): string {
    return base ?? join(env.tools.getHome(), ".genesis-tools", "question", "pending");
}

export function pendingEventFileFor(ts: number, base?: string): string {
    const d = new Date(ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    return join(pendingEventDir(base), `${day}.jsonl`);
}

export function todayPendingEventFile(base?: string): string {
    return pendingEventFileFor(Date.now(), base);
}

export function appendPendingEvent(ev: PendingEventKind, form: AskForm, base?: string): PendingEvent {
    const event: PendingEvent = { id: form.id, ev, ts: Date.now(), form };
    mkdirSync(pendingEventDir(base), { recursive: true });
    // Single-line O_APPEND write — lock-free under concurrent agents, same as the Q→A log.
    appendFileSync(pendingEventFileFor(event.ts, base), `${SafeJSON.stringify(event)}\n`);

    return event;
}
