import { describe, expect, test } from "bun:test";
import { createHandlers } from "./server";

describe("createHandlers", () => {
    test("exposes the MCP tool names from the plan", () => {
        const handlers = createHandlers();
        expect(Object.keys(handlers).sort()).toEqual(
            [
                "ms_teams_conversations",
                "ms_teams_doctor",
                "ms_teams_files",
                "ms_teams_people",
                "ms_teams_search",
                "ms_teams_show",
                "ms_teams_sync",
            ].sort()
        );
    });
});
