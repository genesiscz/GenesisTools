import type { QaRow } from "@dd/contract";

/**
 * Pure, runtime-free QA feed logic — the testable seam (no React, no I/O). Mirrors the web
 * `qa.tsx` resync model: live rows (newest-first) are merged ahead of the persisted `/api/qa/log`
 * rows, deduped by `entry.id`, then filtered by project / tag / free-text. The `useQaStream` /
 * `useQaLog` hooks wire these to the live SSE subscription + the persisted query; the screen calls
 * `filterQa` on the merged list. Keeping this pure means it is covered by `bun:test` without a
 * renderer (same rationale as Pulse's `units.ts`).
 *
 * Defensive by design: the mock client serves THIN `EnrichedQaEntry` fixtures (no `id`/`tag`/… —
 * flagged in the notes), so every field access here tolerates `undefined` rather than crashing the
 * mock / parallel-dev render. On a real device the payload is a full `QaRow` and nothing degrades.
 */

export interface MergeQaArgs {
    /** Rows received live over SSE, newest-first. */
    live: QaRow[];
    /** Rows from the persisted /api/qa/log query (server order: newest-first). */
    persisted: QaRow[];
}

/**
 * Live delivery decides display order and preserves stream-only HTML. Persisted rows are the
 * authority for mutable fields such as readAt, so a later log refresh reconciles cross-device
 * changes instead of being masked by the older live copy.
 */
export function mergeQaRows({ live, persisted }: MergeQaArgs): QaRow[] {
    const canonical = new Map(persisted.filter((row) => row.id != null).map((row) => [row.id, row]));
    const seen = new Set<string>();
    const out: QaRow[] = [];

    for (const list of [live, persisted]) {
        for (const row of list) {
            const id = row.id;

            // A row without an id (thin mock fixture) can't be deduped — keep it rather than drop
            // data. Real-device rows always carry an id, so this only affects the mock path.
            if (id != null) {
                if (seen.has(id)) {
                    continue;
                }

                seen.add(id);
            }

            const persistedRow = id == null ? undefined : canonical.get(id);
            out.push(
                persistedRow
                    ? {
                          ...row,
                          ...persistedRow,
                          answerHtml: persistedRow.answerHtml ?? row.answerHtml,
                          answerHtmlPreview: persistedRow.answerHtmlPreview ?? row.answerHtmlPreview,
                          questionHtml: persistedRow.questionHtml ?? row.questionHtml,
                      }
                    : row
            );
        }
    }

    return out;
}

export interface PersistQaReadToggleOptions {
    persist: () => Promise<unknown>;
    refetch: () => Promise<unknown>;
    isCurrent: () => boolean;
    onAcknowledged: () => void;
    onRejected: (error: unknown) => void;
}

/** Keep an optimistic read override only until its own authoritative refresh settles. */
export async function persistQaReadToggle(options: PersistQaReadToggleOptions): Promise<void> {
    try {
        await options.persist();
        await options.refetch();

        if (options.isCurrent()) {
            options.onAcknowledged();
        }
    } catch (error) {
        if (options.isCurrent()) {
            options.onRejected(error);
        }
    }
}

export interface QaFilter {
    /** Selected project names. A row matches if its project is ANY of these. Empty / undefined = all. */
    projects?: string[];
    /** Selected tags. A row matches if its tag is ANY of these. Empty / undefined = all. */
    tags?: string[];
    /** Free-text query (case-insensitive substring over question/answer/project/refs). */
    text?: string;
}

function rowHaystack(row: QaRow): string {
    const refs = Array.isArray(row.refs) ? row.refs.map((r) => `${r.type}:${r.value}`).join(" ") : "";

    return [row.question, row.answerMd, row.project, row.branch ?? "", row.agentLabel ?? "", refs]
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .toLowerCase();
}

/**
 * Filters merged rows by selected projects + selected tags + free text. A row matches when it
 * matches ANY selected project AND ANY selected tag AND the text. An empty / undefined facet imposes
 * no constraint.
 */
export function filterQa(rows: QaRow[], filter: QaFilter = {}): QaRow[] {
    const projects = filter.projects;
    const tags = filter.tags;
    const text = filter.text?.trim().toLowerCase();

    return rows.filter((row) => {
        if (projects && projects.length > 0 && (!row.project || !projects.includes(row.project))) {
            return false;
        }

        if (tags && tags.length > 0 && (!row.tag || !tags.includes(row.tag))) {
            return false;
        }

        if (text && text.length > 0 && !rowHaystack(row).includes(text)) {
            return false;
        }

        return true;
    });
}

/** Distinct, sorted project names present in the rows (drops empty/missing). */
export function projectsOf(rows: QaRow[]): string[] {
    const set = new Set<string>();

    for (const row of rows) {
        if (typeof row.project === "string" && row.project.length > 0) {
            set.add(row.project);
        }
    }

    return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct tags present in the rows, in a stable canonical order. */
export function tagsOf(rows: QaRow[]): string[] {
    const canonical = ["question", "action", "directive"] as const;
    const present = new Set<string>();

    for (const row of rows) {
        if (typeof row.tag === "string" && row.tag.length > 0) {
            present.add(row.tag);
        }
    }

    const ordered = canonical.filter((t) => present.has(t));
    const extra = [...present].filter((t) => !canonical.includes(t as (typeof canonical)[number])).sort();

    return [...ordered, ...extra];
}
