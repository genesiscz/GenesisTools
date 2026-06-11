import { describe, expect, it } from "bun:test";
import type { QaRow } from "@dd/contract";
import { filterQa, mergeQaRows, projectsOf, tagsOf } from "@/features/qa/live-feed";

/**
 * Pure QA feed logic (no React, no I/O). `filterQa` is multi-select: each facet (projects / tags)
 * matches a row if the row matches ANY selected value (OR within a facet), and facets compose with
 * AND. An empty / undefined facet imposes no constraint.
 */

function mk(id: string, project: string, tag: string): QaRow {
    // Test-local partial fixture: only the fields these helpers read. Cast through unknown — a full
    // QaRow isn't needed to exercise merge/filter/projectsOf/tagsOf.
    return { id, project, tag } as unknown as QaRow;
}

describe("live-feed", () => {
    describe("mergeQaRows", () => {
        it("merges live ahead of persisted, deduped by id", () => {
            const live = [mk("2", "beta", "action")];
            const persisted = [mk("1", "alpha", "question"), mk("2", "beta", "action")];
            expect(mergeQaRows({ live, persisted }).map((r) => r.id)).toEqual(["2", "1"]);
        });

        it("returns an empty array for empty inputs", () => {
            expect(mergeQaRows({ live: [], persisted: [] })).toEqual([]);
        });
    });

    describe("filterQa", () => {
        const rows = [
            mk("1", "alpha", "question"),
            mk("2", "beta", "action"),
            mk("3", "alpha", "action"),
        ];

        it("returns all rows for an empty filter", () => {
            expect(filterQa(rows, {}).length).toBe(3);
            expect(filterQa(rows, { projects: [], tags: [] }).length).toBe(3);
        });

        it("filters by a single project", () => {
            expect(filterQa(rows, { projects: ["alpha"] }).map((r) => r.id)).toEqual(["1", "3"]);
        });

        it("filters by a single tag", () => {
            expect(filterQa(rows, { tags: ["action"] }).map((r) => r.id)).toEqual(["2", "3"]);
        });

        it("matches ANY selected project (OR within the facet)", () => {
            expect(filterQa(rows, { projects: ["alpha", "beta"] }).map((r) => r.id)).toEqual(["1", "2", "3"]);
        });

        it("matches ANY selected tag (OR within the facet)", () => {
            expect(filterQa(rows, { tags: ["question", "action"] }).map((r) => r.id)).toEqual(["1", "2", "3"]);
        });

        it("AND-composes projects + tags", () => {
            expect(filterQa(rows, { projects: ["alpha"], tags: ["action"] }).map((r) => r.id)).toEqual(["3"]);
            expect(filterQa(rows, { projects: ["alpha", "beta"], tags: ["action"] }).map((r) => r.id)).toEqual([
                "2",
                "3",
            ]);
        });
    });

    describe("projectsOf / tagsOf", () => {
        const rows = [
            mk("1", "beta", "action"),
            mk("2", "alpha", "question"),
            mk("3", "alpha", "action"),
        ];

        it("projectsOf returns distinct sorted project names", () => {
            expect(projectsOf(rows)).toEqual(["alpha", "beta"]);
        });

        it("tagsOf returns distinct tags in canonical order", () => {
            expect(tagsOf(rows)).toEqual(["question", "action"]);
        });
    });
});
