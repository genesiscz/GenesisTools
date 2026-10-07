/**
 * Short, stable ids for everything a review talks about, one map per MR, kept on disk so a second
 * session (or a refreshed facts file) gets the same `T03` for the same thread:
 *
 *   F01… changed files (by path)          T01… threads started by others (by discussion id)
 *   D01… my pending drafts (by draft id)  Y01… threads I started (by discussion id)
 *   M01… other open MRs this one affects (by iid)
 *
 * A new item gets the next free number of its kind; an id is never reused or renumbered.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storage } from "@app/gitlab/lib/config";
import type { PrReviewFacts } from "@app/gitlab/lib/pr-review";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export const ID_KINDS = ["F", "T", "D", "Y", "M"] as const;
export type IdKind = (typeof ID_KINDS)[number];

/** A draft that `comments publish` turned into a thread: its D id → the thread and the draft it was. */
export interface PublishedDraft {
    discussionId: string;
    draftId: number;
}

/** kind → item key → number, plus the drafts publishing turned into threads. */
export type IdMap = Record<IdKind, Record<string, number>> & { published?: Record<string, PublishedDraft> };

export function emptyIdMap(): IdMap {
    return { F: {}, T: {}, D: {}, Y: {}, M: {} };
}

export function formatId(kind: IdKind, n: number): string {
    return `${kind}${String(n).padStart(2, "0")}`;
}

/** The ids of `keys` in order; keys the map has not seen get the next free numbers. Mutates `map`. */
export function assignIds(map: IdMap, kind: IdKind, keys: string[]): string[] {
    const table = map[kind];
    let next = Math.max(0, ...Object.values(table)) + 1;

    return keys.map((key) => {
        if (table[key] === undefined) {
            table[key] = next++;
        }

        return formatId(kind, table[key]);
    });
}

/** `T03` → `{ kind: "T", n: 3 }`; also accepts the older lower-case `t3`. Null for anything else. */
export function parseId(id: string): { kind: IdKind; n: number } | null {
    const match = /^([FTDYMftdym])0*(\d+)$/.exec(id.trim());

    if (!match) {
        return null;
    }

    return { kind: match[1].toUpperCase() as IdKind, n: Number(match[2]) };
}

/** The item key behind an id, or null when the map has no such id. */
export function keyOfId(map: IdMap, id: string): { kind: IdKind; key: string } | null {
    const parsed = parseId(id);

    if (!parsed) {
        return null;
    }

    const entry = Object.entries(map[parsed.kind]).find(([, n]) => n === parsed.n);

    return entry ? { kind: parsed.kind, key: entry[0] } : null;
}

export function idMapPath(mr: { host: string; project: string; iid: number }, dir = storage.getBaseDir()): string {
    const project = createHash("sha1").update(`${mr.host} ${mr.project}`).digest("hex").slice(0, 12);

    return join(dir, "review-ids", `${project}-${mr.iid}.json`);
}

export function loadIdMap(path: string): IdMap {
    if (!existsSync(path)) {
        return emptyIdMap();
    }

    try {
        const raw = SafeJSON.parse(readFileSync(path, "utf-8"), { strict: true }) as Partial<IdMap>;

        return { ...emptyIdMap(), ...raw };
    } catch (error) {
        logger.warn({ error, path }, "gitlab: review id map unreadable, starting a new one");

        return emptyIdMap();
    }
}

export function saveIdMap(path: string, map: IdMap): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, SafeJSON.stringify(map, null, 2));
}

/** Discussion id → `T…` for threads others started, `Y…` for the ones `me` started. Mutates `map`. */
export function assignThreadRefs(
    map: IdMap,
    threads: Array<{ id: string; author: string }>,
    me: string | undefined
): Map<string, string> {
    const isMine = (author: string): boolean => Boolean(me) && author === me;
    const others = threads.filter((t) => !isMine(t.author)).map((t) => t.id);
    const mine = threads.filter((t) => isMine(t.author)).map((t) => t.id);
    const otherIds = assignIds(map, "T", others);
    const mineIds = assignIds(map, "Y", mine);

    return new Map([
        ...others.map((id, i) => [id, otherIds[i]] as const),
        ...mine.map((id, i) => [id, mineIds[i]] as const),
    ]);
}

/** The facts with every file, thread, draft and affected MR carrying its id; threads `me` started are `Y`. */
export function applyRefs(facts: PrReviewFacts, map: IdMap): PrReviewFacts {
    const files = assignIds(
        map,
        "F",
        facts.files.map((file) => file.path)
    );
    const threadRefs = assignThreadRefs(map, facts.discussions, facts.me);
    const drafts = assignIds(
        map,
        "D",
        facts.drafts.map((draft) => String(draft.id))
    );
    const impact = facts.impact
        ? assignIds(
              map,
              "M",
              facts.impact.map((entry) => String(entry.iid))
          )
        : [];

    return {
        ...facts,
        files: facts.files.map((file, i) => ({ ...file, ref: files[i] })),
        discussions: facts.discussions.map((d) => ({ ...d, ref: threadRefs.get(d.id) })),
        drafts: facts.drafts.map((draft, i) => ({ ...draft, ref: drafts[i] })),
        impact: facts.impact ? facts.impact.map((entry, i) => ({ ...entry, ref: impact[i] })) : null,
    };
}
