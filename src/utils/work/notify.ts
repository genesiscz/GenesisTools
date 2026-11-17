/**
 * Who hears about a change (P8 decision 3). `resolveNotify` asks the layers in order (the defaults, the machine file,
 * the repository section, the project, then a surface's own key, hub or widget) and the strongest layer that names
 * a level decides; each answer keeps the layer trail, as the write rules do. The consumer reads the journal after its
 * own cursor and hands each line at the level `inbox` or `banner` to a port; `list` means "shows in the tree only".
 *
 * The kinds that reach the widget inbox today (decisions, forms, answers, session to-do items) do not pass through
 * here: they keep their own path, so nothing that shows today stops showing (list 2 of the detail file).
 */
import type { Database } from "bun:sqlite";
import type { Change } from "./model/change";
import type { DeliveredPayload, MovedPayload, PairedPayload } from "./model/payloads";
import { type ItemType, SEVERITIES, type Severity } from "./model/vocab";
import type { NotifyAction, NotifyLevel, NotifyRule, ProjectRules } from "./rules/config";
import type { RuleLayer, RuleLayerInput } from "./rules/resolve";
import { selectChangesAfter, selectItem } from "./store/rows";

export const NOTIFY_SURFACES = ["hub", "widget"] as const;
export type NotifySurface = (typeof NOTIFY_SURFACES)[number];
export type NotifyLayer = RuleLayer | `surface.${NotifySurface}`;

export interface NotifyQuestion {
    type: ItemType;
    action: NotifyAction;
    severity?: Severity;
    /** The item says the defect is in production (`spot --production`). */
    production?: boolean;
}

export interface ResolvedNotify {
    level: NotifyLevel;
    from: NotifyLayer;
    layers: { layer: NotifyLayer; value?: NotifyLevel }[];
}

function rank(severity: Severity | undefined): number {
    return severity === undefined ? Number.POSITIVE_INFINITY : SEVERITIES.indexOf(severity);
}

/** The defaults of decision 3: two new kinds are one inbox line; every other new kind shows in the tree only. */
export function defaultNotify(q: NotifyQuestion): NotifyLevel {
    if (q.action === "reopen-undelivered" && rank(q.severity) <= rank("high")) {
        return "inbox";
    }

    if (q.action === "spotted" && q.type === "bug" && q.production === true) {
        return "inbox";
    }

    return "list";
}

function levelOf(rule: NotifyRule | undefined, q: NotifyQuestion): NotifyLevel | undefined {
    if (rule === undefined) {
        return undefined;
    }

    if (typeof rule === "string") {
        return rule;
    }

    // A rule with a severity floor applies from that severity up; below it the weaker layer decides.
    return rank(q.severity) <= rank(rule.minSeverity) ? rule.level : undefined;
}

function ruleOf(rules: ProjectRules | undefined, q: NotifyQuestion): NotifyRule | undefined {
    return rules?.notify?.[q.type]?.[q.action] ?? rules?.notify?.["*"]?.[q.action];
}

export function resolveNotify(
    layers: readonly RuleLayerInput[],
    q: NotifyQuestion,
    surface?: { id: NotifySurface; rules: ProjectRules }
): ResolvedNotify {
    const base = defaultNotify(q);
    const trail: ResolvedNotify["layers"] = [{ layer: "default", value: base }];
    let level = base;
    let from: NotifyLayer = "default";
    const all: { layer: NotifyLayer; rules: ProjectRules }[] = [
        ...layers.filter((l) => l.layer !== "default"),
        ...(surface !== undefined ? [{ layer: `surface.${surface.id}` as const, rules: surface.rules }] : []),
    ];

    for (const { layer, rules } of all) {
        const value = levelOf(ruleOf(rules, q), q);
        trail.push({ layer, ...(value !== undefined ? { value } : {}) });

        if (value !== undefined) {
            level = value;
            from = layer;
        }
    }

    return { level, from, layers: trail };
}

/** The notify action a journal change stands for; null for a change nobody is told about. */
export function notifyActionOf(change: Change): NotifyAction | null {
    switch (change.kind) {
        case "created":
            return (change.payload as { state?: string }).state === "spotted" ? "spotted" : null;
        case "moved": {
            const moved = change.payload as MovedPayload;

            if (moved.reconcile === true) {
                return null;
            }

            if (moved.from === "spotted" && moved.to === "open") {
                return "accepted";
            }

            return moved.to === "done"
                ? "finished"
                : moved.to === "dropped"
                  ? "dropped"
                  : moved.to === "reopened"
                    ? "reopened"
                    : moved.to === "active"
                      ? "claimed"
                      : null;
        }
        case "delivered":
            return (change.payload as DeliveredPayload).receipt.outcome === "nobody-alive"
                ? "reopen-undelivered"
                : null;
        case "commented":
            return "commented";
        case "paired": {
            const state = (change.payload as PairedPayload).pairing.state;
            return state === "held" ? "sync-held" : state === "failed" ? "sync-failed" : null;
        }
        default:
            return null;
    }
}

export interface NotifyLine {
    item: string;
    project: string;
    type: ItemType;
    action: NotifyAction;
    level: NotifyLevel;
    title: string;
    text: string;
    /** The session that made the change, so the inbox groups the line under it. */
    sessionId: string | null;
}

export interface NotifyDeps {
    db: Database;
    /** The layers of a project's rules. */
    layers(project: string): readonly RuleLayerInput[];
    inbox(line: NotifyLine): Promise<void>;
}

export interface NotifyReport {
    seen: number;
    sent: number;
    cursor: number;
}

const CURSOR = "notify";
const BATCH = 500;

const ACTION_WORDS: Record<NotifyAction, string> = {
    spotted: "spotted",
    accepted: "accepted",
    claimed: "claimed",
    finished: "finished",
    reopened: "reopened",
    "reopen-undelivered": "reopened, and no session took the message",
    dropped: "dropped",
    commented: "has a new comment",
    "sync-held": "has a change held for a lead or the owner",
    "sync-failed": "could not be pushed",
};

/**
 * One pass. The batch is taken under BEGIN IMMEDIATE (the cursor moves before the lines go out), so two runners never
 * send the same line; a runner that dies after the move loses its lines, which is the cheaper failure for an inbox.
 */
export async function runNotifyOnce(deps: NotifyDeps): Promise<NotifyReport> {
    const { db } = deps;
    let changes: Change[] = [];
    let cursor = 0;

    db.run("BEGIN IMMEDIATE");

    try {
        // A new cursor starts at the journal's head: the first pass never tells about the store's whole history.
        db.run("INSERT OR IGNORE INTO cursors (consumer, seq) SELECT ?, COALESCE(MAX(seq), 0) FROM changes", [CURSOR]);
        cursor = (db.query("SELECT seq FROM cursors WHERE consumer = ?").get(CURSOR) as { seq: number }).seq;
        changes = selectChangesAfter(db, cursor, BATCH);

        if (changes.length > 0) {
            cursor = changes[changes.length - 1].seq;
            db.run("UPDATE cursors SET seq = ? WHERE consumer = ?", [cursor, CURSOR]);
        }

        db.run("COMMIT");
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    }

    let sent = 0;

    for (const change of changes) {
        const action = notifyActionOf(change);
        const item = action === null ? null : selectItem(db, change.item);

        if (action === null || item === null) {
            continue;
        }

        const resolved = resolveNotify(deps.layers(item.project), {
            type: item.type,
            action,
            ...(item.severity !== null && item.severity !== undefined ? { severity: item.severity } : {}),
            production: item.fields.production === true,
        });

        if (resolved.level !== "inbox" && resolved.level !== "banner") {
            continue;
        }

        await deps.inbox({
            item: item.id,
            project: item.project,
            type: item.type,
            action,
            level: resolved.level,
            title: `${item.type} ${item.id} ${ACTION_WORDS[action]}`,
            text: `${item.title}\n\n${item.project} · decided by ${resolved.from}`,
            sessionId: change.actor.sessionId,
        });
        sent++;
    }

    return { seen: changes.length, sent, cursor };
}
