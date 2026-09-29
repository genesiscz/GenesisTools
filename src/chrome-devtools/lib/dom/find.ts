import type { DomAction, DomActionKind, DomSnapshot } from "./in-page";

export interface TargetQuery {
    /** Matched against the label, or against the option label of a select row. */
    text: string;
    kinds: DomActionKind[];
    role?: string;
}

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** What a person reads on the row: the option for a select row, the label for anything else. */
export function targetLabel(action: DomAction): string {
    return action.kind === "select" && action.option ? action.option.label : action.label;
}

/**
 * The rows of one read that `query` names. Exact label matches (case and spacing ignored) win over
 * substring matches, so "Save" does not also pick "Save as". The caller refuses several matches
 * unless told which one: a command line cannot carry a node id from an earlier read, because ids
 * and guards belong to one isolated world and a new process gets a new one.
 */
export function findTargets(snapshot: DomSnapshot, query: TargetQuery): DomAction[] {
    const wanted = normalized(query.text);
    const pool = snapshot.actions.filter(
        (action) => query.kinds.includes(action.kind) && (query.role === undefined || action.role === query.role)
    );
    const exact = pool.filter((action) => normalized(targetLabel(action)) === wanted);
    if (exact.length > 0) {
        return exact;
    }

    return pool.filter((action) => normalized(targetLabel(action)).includes(wanted));
}
