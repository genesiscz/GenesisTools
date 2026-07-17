import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { clearUserScopedQueries, USER_SCOPED_QUERY_KEYS } from "./user-queries";

describe("clearUserScopedQueries", () => {
    test("drops user-scoped data but keeps public queries", () => {
        const qc = new QueryClient();
        qc.setQueryData(["me"], { user: { email: "a@b.c" } });
        qc.setQueryData(["userSettings"], { theme: "dark" });
        qc.setQueryData(["collections"], [{ id: 1 }]);
        qc.setQueryData(["collection", 1], { videos: [] });
        qc.setQueryData(["digest", 7], { channels: [] });
        qc.setQueryData(["channels"], [{ handle: "@x" }]);
        qc.setQueryData(["videos", {}], [{ id: "v" }]);

        clearUserScopedQueries(qc);

        expect(qc.getQueryData(["me"])).toBeUndefined();
        expect(qc.getQueryData(["userSettings"])).toBeUndefined();
        expect(qc.getQueryData(["collections"])).toBeUndefined();
        expect(qc.getQueryData(["collection", 1])).toBeUndefined();
        expect(qc.getQueryData(["digest", 7])).toBeUndefined();
        // Public data survives logout.
        expect(qc.getQueryData(["channels"])).toBeDefined();
        expect(qc.getQueryData(["videos", {}])).toBeDefined();
    });

    test("covers the me query that gates the account UI", () => {
        expect(USER_SCOPED_QUERY_KEYS).toContain("me");
    });
});
