import { findById, findByName } from "./derived-registry";
import { FriendlyError, listAvailableNames } from "./errors";
import type { AgentRecord } from "./types";

const ID_LIKE = /^(agt_|main_)/;

function parseCsv(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }

    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function looksLikeId(token: string): boolean {
    return ID_LIKE.test(token);
}

export function resolveOne(records: AgentRecord[], token: string, role: "sender" | "recipient"): AgentRecord {
    const found = looksLikeId(token) ? findById(records, token) : findByName(records, token);

    if (!found) {
        throw new FriendlyError(
            `${role} "${token}" not registered in this session`,
            `Registered: ${listAvailableNames(records)}\nTokens are matched as agent_id when they start with agt_/main_, else as agent_name.`
        );
    }

    if (role === "recipient" && found.agent_id === "") {
        throw new FriendlyError(
            `recipient "${token}" is registered but has not logged in yet (no agent_id assigned)`,
            `Wait for the subagent to run:\n  tools agents login --agent-name ${found.agent_name}\nOr check status:\n  tools agents discover`
        );
    }

    return found;
}

export function resolveMany(records: AgentRecord[], csv: string | undefined, role: "recipient"): string[] {
    const tokens = parseCsv(csv);
    const resolved: string[] = [];

    for (const token of tokens) {
        const found = resolveOne(records, token, role);

        if (!resolved.includes(found.agent_id)) {
            resolved.push(found.agent_id);
        }
    }

    return resolved;
}

export { parseCsv };
