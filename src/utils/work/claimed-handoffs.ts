import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import { type ItemState, OPEN_STATES } from "./model/vocab";

export interface HandoffClaimant {
    sessionId: string;
    harness: string;
    title: string;
}

export interface ClaimedHandoff {
    id: string;
    project: string;
    title: string;
    claimants: HandoffClaimant[];
    members: { id: string; title: string; slot: string | null; state: ItemState }[];
}

const openHandoffClaims = `FROM items h JOIN claims c ON c.item = h.id
    WHERE h.type = 'handoff' AND h.state IN (${OPEN_STATES.map(() => "?").join(", ")})
      AND c.active = 1 AND json_extract(c.by, '$.sessionId') IS NOT NULL`;

interface ClaimRow {
    id: string;
    project: string;
    title: string;
    sessionId: string;
    harness: string;
    sessionTitle: string | null;
}

/** Only ask the local session hosts about sessions with something to show. */
export function handoffClaimantIds(db: Database): string[] {
    return db
        .query<{ id: string }, ItemState[]>(`SELECT DISTINCT c.session_id AS id ${openHandoffClaims}`)
        .all(...OPEN_STATES)
        .map((row) => row.id);
}

/** The claims and member states come from the same SQLite snapshot, even if another session just released its claim. */
export function claimedHandoffTree(db: Database, liveSessionIds: ReadonlySet<string>): ClaimedHandoff[] {
    if (liveSessionIds.size === 0) {
        return [];
    }

    return db.transaction(() => {
        const handoffs = new Map<string, ClaimedHandoff>();
        const claims = db
            .query<ClaimRow, string[]>(
                `SELECT h.id, h.project, h.title, c.session_id AS sessionId,
                        json_extract(c.by, '$.harness') AS harness, json_extract(c.by, '$.sessionTitle') AS sessionTitle
                 ${openHandoffClaims} AND c.session_id IN (SELECT value FROM json_each(?))
                 ORDER BY h.project, h.title, h.id, c.session_id`
            )
            .all(...OPEN_STATES, SafeJSON.stringify([...liveSessionIds], { strict: true }));

        for (const claim of claims) {
            let handoff = handoffs.get(claim.id);
            if (!handoff) {
                handoff = { id: claim.id, project: claim.project, title: claim.title, claimants: [], members: [] };
                handoffs.set(claim.id, handoff);
            }

            handoff.claimants.push({
                sessionId: claim.sessionId,
                harness: claim.harness,
                title: claim.sessionTitle ?? claim.sessionId,
            });
        }

        const members = db
            .query<ClaimedHandoff["members"][number] & { handoff: string }, [string]>(
                `SELECT r.from_id AS handoff, m.id, m.title, r.slot, m.state
                 FROM refs r JOIN items m ON m.id = r.to_id
                 WHERE r.from_id IN (SELECT value FROM json_each(?)) AND r.kind = 'member'
                 ORDER BY r.from_id, r.slot IS NULL, CAST(substr(r.slot, 2) AS INTEGER), r.id`
            )
            .all(SafeJSON.stringify([...handoffs.keys()], { strict: true }));

        for (const { handoff, ...member } of members) {
            handoffs.get(handoff)?.members.push(member);
        }

        return [...handoffs.values()];
    })();
}
