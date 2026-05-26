import { describe, expect, it } from "bun:test";
import { resolveRunSession } from "@app/task/lib/resolve-run-session";
import type { TaskSessionStore } from "@app/task/lib/session-store";

function mockStore(overrides: Partial<TaskSessionStore> = {}): TaskSessionStore {
    return {
        getSessionsDir: async () => "/tmp/sessions",
        sessionFilesExist: () => false,
        getLastLineSeq: async () => 0,
        ...overrides,
    } as TaskSessionStore;
}

describe("resolveRunSession", () => {
    it("returns requested name when session files do not exist", async () => {
        const store = mockStore({ sessionFilesExist: () => false });

        const resolved = await resolveRunSession(store, "fresh", {
            explicitSessionFlag: false,
            interactive: true,
        });

        expect(resolved).toEqual({ session: "fresh", requested: "fresh", renamed: false });
    });

    it("defaults to reuse-continue when --session flag is explicit", async () => {
        const store = mockStore({
            sessionFilesExist: () => true,
            getLastLineSeq: async () => 12,
        });

        const resolved = await resolveRunSession(store, "metro", {
            explicitSessionFlag: true,
            interactive: false,
        });

        expect(resolved).toEqual({
            session: "metro",
            requested: "metro",
            renamed: false,
            reuse: "reuse-continue",
            previousLastSeq: 12,
        });
    });

    it("prefixes session in non-interactive mode without explicit flag", async () => {
        const store = mockStore({
            sessionFilesExist: (name) => name === "metro",
        });

        const resolved = await resolveRunSession(store, "metro", {
            explicitSessionFlag: false,
            interactive: false,
        });

        expect(resolved?.requested).toBe("metro");
        expect(resolved?.renamed).toBe(true);
        expect(resolved?.reuse).toBe("prefix");
        expect(resolved?.session).toMatch(/^metro-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    });
});
