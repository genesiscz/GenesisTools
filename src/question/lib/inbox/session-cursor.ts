import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { decisionFiles } from "../decisions/paths";
import { logDir } from "../log-store";
import type { QaRow } from "../read-model";
import type { InboxDecision, InboxForm } from "./build";
import type { SessionInbox, SessionTodo } from "./load";

const { log } = logger.scoped("question-inbox");

/**
 * The cursor of `tools question inbox --session <id> --json --all-items --since <cursor>`.
 *
 * A cursor names one answer: the hash of its whole JSON. Beside it the store keeps the identity (inode, size, mtime,
 * ctime) of every file that answer was built from, taken BEFORE that file was read, and one hash per item. A call
 * with `--since <cursor>`:
 *
 * - finds the cursor's snapshot and stats the same files again. Every identity equal: the inputs did not change, so
 *   the answer would be the same; it answers "nothing changed" without reading anything.
 * - otherwise builds the whole answer and returns only the items whose hash differs from the cursor's, plus the ids
 *   that are gone, and the new cursor.
 *
 * It cannot skip a change: an answer that read anything the snapshot does not list (a ref found by a search of the
 * checkout, a folder from the session listing, a block with no time of its own) is stored without identities, and a
 * cursor without identities never takes the fast path. An unknown cursor (evicted, another version, a lost write)
 * gets the full answer. A write during the read leaves a newer identity than the stored one, so the next call reads.
 */

/** v1: the first cursor. Bump when the answer's shape or an input changes, so an old snapshot is never trusted. */
const CURSOR_VERSION = 1;
/** Snapshots kept per session: one per caller that holds a cursor (the mods, the hub, the widget), with room. */
const KEEP = 8;

export interface InputProbe {
    path: string;
    /** `ino:size:mtimeNs:ctimeNs`, or `absent`. */
    id: string;
}

/** What one answer read: every file, each probed before its read; `unprovable` when it read something else too. */
export class InboxTrace {
    readonly probes: InputProbe[] = [];
    unprovable: string | null = null;

    probe(path: string): void {
        if (!this.probes.some((probe) => probe.path === path)) {
            this.probes.push({ path, id: identityOf(path) });
        }
    }

    cannotProve(reason: string): void {
        this.unprovable ??= reason;
    }
}

interface Snapshot {
    cursor: string;
    /** Null: the answer read an input it cannot re-check, so this cursor never answers "unchanged". */
    probes: InputProbe[] | null;
    items: Record<string, string>;
    at: number;
}

const KINDS = ["decisions", "todos", "entries", "forms"] as const;
type Kind = (typeof KINDS)[number];

/** The items that changed since a cursor, the ids that are gone, and the staged text when it moved. */
export interface SessionInboxDelta {
    decisions: InboxDecision[];
    todos: SessionTodo[];
    entries: QaRow[];
    forms: InboxForm[];
    removed: Record<Kind, string[]>;
    /** Present only when it changed: the new text, or null when nothing is staged any more. */
    staged?: string | null;
}

export function identityOf(path: string): string {
    try {
        const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
        return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "absent";
    } catch (error) {
        // An unreadable path is not "absent": a fresh id every time, so it never matches and never takes the fast path.
        log.debug({ error, path }, "inbox cursor: input not stat'ed");
        return `unreadable:${Date.now()}:${Math.random()}`;
    }
}

/**
 * The inputs every session answer reads: the decision log, the Q→A store with its write-ahead log, and the Q→A day
 * logs it catches up from (each file, so a new day's log counts too). The transcript and the refs' files are probed
 * where they are read.
 */
export function baseTrace(): InboxTrace {
    const trace = new InboxTrace();
    const qa = genesisToolsDir("question", "qa.db");
    trace.probe(decisionFiles().file);
    trace.probe(qa);
    trace.probe(`${qa}-wal`);
    const dir = logDir();
    let names: string[];

    try {
        names = readdirSync(dir)
            .filter((name) => name.endsWith(".jsonl"))
            .sort();
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            log.debug({ error, dir }, "inbox cursor: log folder not listed");
            trace.cannotProve("the Q→A log folder could not be listed");
        }

        names = [];
    }

    trace.probes.push({ path: `${dir}/`, id: logNamesId(dir) });

    for (const name of names) {
        trace.probe(join(dir, name));
    }

    return trace;
}

/** The Q→A day log names, as one id: a new day's file moves it. */
function logNamesId(dir: string): string {
    try {
        const names = readdirSync(dir)
            .filter((name) => name.endsWith(".jsonl"))
            .sort();
        return `names:${hashOf(names.join("\n"))}`;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return `names:${hashOf("")}`;
        }

        return `unreadable:${Date.now()}`;
    }
}

function hashOf(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function storePath(session: string): string {
    return genesisToolsDir("question", "cache", "session-inbox", `${hashOf(session)}.json`);
}

function isSnapshot(value: unknown): value is Snapshot {
    return (
        typeof value === "object" &&
        value !== null &&
        "cursor" in value &&
        typeof value.cursor === "string" &&
        "probes" in value &&
        (value.probes === null || Array.isArray(value.probes)) &&
        "items" in value &&
        typeof value.items === "object" &&
        value.items !== null
    );
}

function loadStore(session: string): Snapshot[] {
    let raw: string;

    try {
        raw = readFileSync(storePath(session), "utf8");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            log.debug({ error, session }, "inbox cursor: store not readable");
        }

        return [];
    }

    try {
        const parsed: unknown = SafeJSON.parse(raw, { strict: true });

        if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("version" in parsed) ||
            parsed.version !== CURSOR_VERSION ||
            !("session" in parsed) ||
            parsed.session !== session ||
            !("snapshots" in parsed) ||
            !Array.isArray(parsed.snapshots)
        ) {
            return [];
        }

        return parsed.snapshots.filter(isSnapshot);
    } catch (error) {
        log.debug({ error, session }, "inbox cursor: store not parseable");
        return [];
    }
}

/** Whether `cursor`'s answer is still the answer: its snapshot exists, was provable, and no input moved. */
export function cursorStillHolds(session: string, cursor: string): boolean {
    const snapshot = loadStore(session).find((candidate) => candidate.cursor === cursor);

    if (!snapshot?.probes) {
        return false;
    }

    return snapshot.probes.every((probe) =>
        probe.path.endsWith("/") && probe.id.startsWith("names:")
            ? logNamesId(probe.path.slice(0, -1)) === probe.id
            : identityOf(probe.path) === probe.id
    );
}

function itemKey(kind: Kind, id: string): string {
    return `${kind}\0${id}`;
}

function itemHashes(answer: SessionInbox): Record<string, string> {
    const items: Record<string, string> = {};

    for (const kind of KINDS) {
        for (const item of answer[kind]) {
            items[itemKey(kind, item.id)] = hashOf(SafeJSON.stringify(item, { strict: true }));
        }
    }

    items.staged = hashOf(answer.staged ?? "");
    return items;
}

/**
 * Stores this answer's snapshot and returns its cursor, plus the change since `since` when that cursor is known (null
 * when it is not: the caller then sends the whole answer).
 */
export function recordAnswer({
    session,
    answer,
    trace,
    since,
}: {
    session: string;
    answer: SessionInbox;
    trace: InboxTrace;
    since?: string;
}): { cursor: string; delta: SessionInboxDelta | null } {
    const cursor = `c${CURSOR_VERSION}-${hashOf(SafeJSON.stringify(answer, { strict: true }))}`;
    const items = itemHashes(answer);
    const snapshots = loadStore(session);
    const previous = since ? snapshots.find((snapshot) => snapshot.cursor === since) : undefined;
    const snapshot: Snapshot = {
        cursor,
        probes: trace.unprovable ? null : trace.probes,
        items,
        at: Date.now(),
    };

    if (trace.unprovable) {
        log.debug({ session, reason: trace.unprovable }, "inbox cursor: this answer cannot take the fast path");
    }

    const kept = [snapshot, ...snapshots.filter((candidate) => candidate.cursor !== cursor)].slice(0, KEEP);

    try {
        atomicWriteFileSync(
            storePath(session),
            SafeJSON.stringify({ version: CURSOR_VERSION, session, snapshots: kept }, { strict: true })
        );
    } catch (error) {
        log.warn({ error, session }, "inbox cursor: snapshot not saved; the next --since gets the whole answer");
    }

    if (!previous) {
        return { cursor, delta: null };
    }

    const moved = (kind: Kind, id: string) => previous.items[itemKey(kind, id)] !== items[itemKey(kind, id)];
    const gone = (kind: Kind): string[] => {
        const now = new Set(answer[kind].map((item) => item.id));
        const prefix = `${kind}\0`;
        return Object.keys(previous.items)
            .filter((key) => key.startsWith(prefix) && !now.has(key.slice(prefix.length)))
            .map((key) => key.slice(prefix.length));
    };

    return {
        cursor,
        delta: {
            decisions: answer.decisions.filter((item) => moved("decisions", item.id)),
            todos: answer.todos.filter((item) => moved("todos", item.id)),
            entries: answer.entries.filter((item) => moved("entries", item.id)),
            forms: answer.forms.filter((item) => moved("forms", item.id)),
            removed: {
                decisions: gone("decisions"),
                todos: gone("todos"),
                entries: gone("entries"),
                forms: gone("forms"),
            },
            ...(previous.items.staged !== items.staged ? { staged: answer.staged ?? null } : {}),
        },
    };
}
