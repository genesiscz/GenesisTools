import { describe, expect, test } from "bun:test";
import { migrateNavOrder } from "@/hooks/useNavOrder";
import { reconcileOrder } from "@/lib/block-layout";
import { NAV_ROUTES } from "@/lib/nav-routes";

const DEFAULTS = NAV_ROUTES.map((r) => r.to);

function resolve(stored: string[]): string[] {
    return reconcileOrder(migrateNavOrder(stored), DEFAULTS);
}

describe("migrateNavOrder", () => {
    test("a stored /claude keeps its position as /ai/accounts", () => {
        expect(resolve(["/qa", "/claude", "/"]).slice(0, 3)).toEqual(["/qa", "/ai/accounts", "/"]);
    });

    test("/claude is gone from the defaults, so an unmigrated order would drop it", () => {
        expect(DEFAULTS).not.toContain("/claude");
        expect(reconcileOrder(["/qa", "/claude", "/"], DEFAULTS).slice(0, 2)).toEqual(["/qa", "/"]);
    });

    test("paths that were not renamed pass through untouched", () => {
        expect(migrateNavOrder(["/qa", "/ai/accounts", "/todos"])).toEqual(["/qa", "/ai/accounts", "/todos"]);
    });

    test("a stored order of known routes is not reshuffled and new routes append", () => {
        const stored = ["/qa", "/"];

        expect(resolve(stored).slice(0, 2)).toEqual(stored);
        expect(resolve(stored).slice(2)).toEqual(DEFAULTS.filter((to) => !stored.includes(to)));
    });
});
