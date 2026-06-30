import type { AgentMode, AgentRecord, FeedEvent } from "./types";

/**
 * Replay feed events into the current set of AgentRecords.
 *
 * This is the single source of truth — there is no persisted `registry.json`.
 * `last_delivered_seq` lives in a per-agent cursor sidecar file (cursor.ts),
 * not in the AgentRecord, because it's runtime state of an active login.
 */
export function deriveRegistry(events: FeedEvent[]): AgentRecord[] {
    const byId = new Map<string, AgentRecord>();

    for (const event of events) {
        if (event.type === "registered") {
            if (!event.agent_id) {
                continue;
            }

            byId.set(event.agent_id, {
                agent_id: event.agent_id,
                agent_name: event.agent_name,
                is_main: event.is_main,
                role: event.role,
                registered_at: event.ts,
                logged_in_at: null,
                logged_out_at: null,
                mode: null,
                meta: event.meta,
            });
            continue;
        }

        if (event.type === "logged_in") {
            const existing = byId.get(event.agent_id);

            if (!existing) {
                continue;
            }

            byId.set(event.agent_id, {
                ...existing,
                logged_in_at: event.ts,
                logged_out_at: null,
                mode: event.mode satisfies AgentMode,
            });
            continue;
        }

        if (event.type === "logged_out") {
            const existing = byId.get(event.agent_id);

            if (!existing) {
                continue;
            }

            byId.set(event.agent_id, { ...existing, logged_out_at: event.ts });
        }
    }

    return Array.from(byId.values());
}

export function findByName(records: AgentRecord[], agentName: string): AgentRecord | undefined {
    return records.find((r) => r.agent_name === agentName);
}

export function findById(records: AgentRecord[], agentId: string): AgentRecord | undefined {
    return records.find((r) => r.agent_id === agentId);
}

export function isMainRegistered(records: AgentRecord[]): boolean {
    return records.some((r) => r.is_main);
}

const AGT_SUFFIX_RE = /^agt_([0-9a-f]+)$/i;

/**
 * Pick the next `agt_xxxx` id by taking max(numeric-suffix)+1 across registered
 * agents. Count+1 would collide if a user passed `--agent-id agt_0005` directly.
 */
export function nextSubagentId(records: AgentRecord[]): string {
    let maxSuffix = 0;

    for (const r of records) {
        const match = AGT_SUFFIX_RE.exec(r.agent_id);

        if (!match?.[1]) {
            continue;
        }

        const n = Number.parseInt(match[1], 16);

        if (Number.isFinite(n) && n > maxSuffix) {
            maxSuffix = n;
        }
    }

    return `agt_${(maxSuffix + 1).toString(16).padStart(4, "0")}`;
}
