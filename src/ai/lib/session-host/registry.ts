import { logger } from "@genesiscz/utils/logger";
import { cmuxSessionHost } from "./hosts/cmux";
import { t3SessionHost } from "./hosts/t3";
import type {
    SessionHostAction,
    SessionHostActResult,
    SessionHostAdapter,
    SessionHostAnswer,
    SessionHostKind,
    SessionHostView,
} from "./types";

const { log } = logger.scoped("session-host");

/** One adapter per host kind. A kind without an entry fails the compile. */
export const SESSION_HOSTS: Record<SessionHostKind, SessionHostAdapter> = {
    cmux: cmuxSessionHost,
    t3: t3SessionHost,
};

/**
 * Which host answers when two claim a session. T3 Code first: its record is the app that runs the session now,
 * while the cmux journal also keeps the pane a session started in before it moved.
 */
export const SESSION_HOST_ORDER: readonly SessionHostKind[] = ["t3", "cmux"];

export interface SessionHostTable {
    hosts: Record<SessionHostKind, SessionHostAdapter>;
    order: readonly SessionHostKind[];
}

const LIVE_TABLE: SessionHostTable = { hosts: SESSION_HOSTS, order: SESSION_HOST_ORDER };

/** The sentence for a session no host holds, naming each host that was asked: "No T3 Code thread or cmux pane …". */
export function noHostReason(table: SessionHostTable = LIVE_TABLE): string {
    const places = table.order.map((kind) => table.hosts[kind].place);
    const listed = places.length <= 1 ? places.join("") : `${places.slice(0, -1).join(", ")} or ${places.at(-1)}`;
    return `No ${listed} holds this session.`;
}

/**
 * Where each session lives. Every host reads once for the whole list; the first host in `order` that holds a session
 * answers for it. A host that fails is logged and skipped, so one broken host never hides the other.
 */
export async function describeSessionHosts(
    sessionIds: readonly string[],
    table: SessionHostTable = LIVE_TABLE
): Promise<SessionHostAnswer[]> {
    const answers = await Promise.all(
        table.order.map(async (kind) => {
            try {
                return await table.hosts[kind].describe(sessionIds);
            } catch (error) {
                log.warn({ error, kind }, "a session host could not describe its sessions");
                return new Map<string, SessionHostView>();
            }
        })
    );
    const reason = noHostReason(table);

    return sessionIds.map((sessionId) => {
        const host = answers.map((views) => views.get(sessionId)).find((view) => view !== undefined);
        return host ? { sessionId, host } : { sessionId, host: null, reason };
    });
}

/** Performs an action on a session through the host that holds it; a disabled action answers its reason. */
export async function actOnSessionHost(
    { sessionId, action }: { sessionId: string; action: SessionHostAction },
    table: SessionHostTable = LIVE_TABLE
): Promise<SessionHostActResult & { host: SessionHostView | null }> {
    const [answer] = await describeSessionHosts([sessionId], table);

    if (!answer.host) {
        return { ok: false, reason: answer.reason, host: null };
    }

    const state = answer.host.actions[action];

    if (!state.enabled) {
        return { ok: false, reason: state.reason, host: answer.host };
    }

    const result = await table.hosts[answer.host.kind].act(action, sessionId);
    log.info({ sessionId, action, kind: answer.host.kind, ok: result.ok }, "session host action");
    return { ...result, host: answer.host };
}
