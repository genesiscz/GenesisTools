import { describe, expect, test } from "bun:test";
import { resolveSessionQuery } from "@app/utils/tmux/match";
import type { TmuxSessionInfo } from "@app/utils/tmux/types";

function info(name: string, attached = 0): TmuxSessionInfo {
    return { name, attached, windows: 1 };
}

describe("resolveSessionQuery", () => {
    const sessions = [info("dev-dashboard-1"), info("dev-dashboard-2", 1), info("api"), info("worker")];

    test("exact name match wins even when it is also a substring of others", () => {
        const result = resolveSessionQuery("api", [info("api"), info("api-worker")]);
        expect(result).toEqual({ kind: "exact", name: "api" });
    });

    test("single substring match resolves to that session", () => {
        const result = resolveSessionQuery("work", sessions);
        expect(result).toEqual({ kind: "single", name: "worker" });
    });

    test("multiple substring matches are ambiguous and list all matches", () => {
        const result = resolveSessionQuery("dashboard", sessions);
        expect(result).toEqual({ kind: "ambiguous", matches: ["dev-dashboard-1", "dev-dashboard-2"] });
    });

    test("no match yields none", () => {
        const result = resolveSessionQuery("ghost", sessions);
        expect(result).toEqual({ kind: "none" });
    });

    test("query is trimmed before matching", () => {
        const result = resolveSessionQuery("  api  ", sessions);
        expect(result).toEqual({ kind: "exact", name: "api" });
    });
});
