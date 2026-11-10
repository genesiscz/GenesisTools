import { describe, expect, it } from "bun:test";
import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { isBoundFromRow } from "@app/dev-dashboard/server/bind";
import { createDashboardRouter } from "@app/dev-dashboard/server/registry";

/** Not table rows on purpose: the 57 board routes, and the public shared-note page (`routes/share.ts`). */
function outsideTable(pattern: string): boolean {
    return pattern.startsWith("/api/boards") || pattern === "/share/:slug";
}

describe("the endpoint table is the only declaration of a dashboard route", () => {
    const router = createDashboardRouter();
    const defs = router.list();

    it("binds every row by exactly one route, and no earlier pattern shadows it", () => {
        const problems: string[] = [];

        for (const [name, row] of Object.entries(ENDPOINTS)) {
            const same = defs.filter((def) => def.method === row.method && def.pattern === row.path);
            const bound = same.filter(isBoundFromRow);

            if (bound.length !== 1 || same.length !== 1) {
                problems.push(`${name}: ${bound.length} bound and ${same.length - bound.length} hand routes`);
                continue;
            }

            const probe = row.path.replace(/:[^/]+/g, "sample");

            if (router.match(row.method, probe)?.def !== bound[0]) {
                problems.push(`${name}: ${row.method} ${probe} reaches another route first`);
            }
        }

        expect(problems).toEqual([]);
    });

    it("has no hand-written pattern outside the boards and the shared-note page", () => {
        const hand = defs
            .filter((def) => !isBoundFromRow(def) && !outsideTable(def.pattern))
            .map((def) => `${def.method} ${def.pattern}`);

        expect(hand).toEqual([]);
    });

    it("still serves the shared-note page", () => {
        expect(router.match("GET", "/share/tok")).not.toBeNull();
    });
});
