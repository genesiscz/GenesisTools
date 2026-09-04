import { describe, expect, test } from "bun:test";
import { filtersFromHistoryOptions } from "./history-cli";

describe("filtersFromHistoryOptions", () => {
    test("defaults cwd to the process cwd unless --all", () => {
        const scoped = filtersFromHistoryOptions("restore", { limit: "5" }, "/Users/me/Projects/shop");
        expect(scoped.cwd).toBe("/Users/me/Projects/shop");
        expect(scoped.limit).toBe(5);
        expect(scoped.query).toBe("restore");

        const byLeaf = filtersFromHistoryOptions("restore", { project: "GenesisTools" }, "/Users/me/Projects/shop");
        expect(byLeaf.cwd).toBeUndefined();
        expect(byLeaf.project).toBe("GenesisTools");

        const all = filtersFromHistoryOptions(undefined, { all: true }, "/Users/me/Projects/shop");
        expect(all.cwd).toBeUndefined();
        expect(all.all).toBe(true);
    });
});

describe("filtersFromHistoryOptions --project", () => {
    test("--project fills the project filter, not cwd", () => {
        // It used to land in `cwd`, which is compared against the ABSOLUTE path,
        // so `-p GenesisTools` matched nothing and printed "No conversations".
        const filters = filtersFromHistoryOptions("rebase", { project: "shop" }, "/Users/me/Projects/other");

        expect(filters.project).toBe("shop");
        expect(filters.cwd).toBeUndefined();
    });

    test("--cwd still pins the absolute directory", () => {
        const filters = filtersFromHistoryOptions(undefined, { cwd: "/Users/me/Projects/shop" }, "/Users/me/other");

        expect(filters.cwd).toBe("/Users/me/Projects/shop");
        expect(filters.project).toBeUndefined();
    });

    test("--all wins over --project", () => {
        const filters = filtersFromHistoryOptions(undefined, { all: true, project: "shop" }, "/Users/me/other");

        expect(filters.project).toBeUndefined();
        expect(filters.cwd).toBeUndefined();
    });
});
