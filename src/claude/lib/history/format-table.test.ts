import { describe, expect, it } from "bun:test";
import { HISTORY_TABLE_HEADERS, historyTablePlainRow } from "./format-table";
import type { SearchResult } from "./types";

function result(overrides: Partial<SearchResult> & Pick<SearchResult, "project" | "sessionId">): SearchResult {
    return {
        filePath: `/tmp/${overrides.sessionId}.jsonl`,
        timestamp: new Date("2026-08-28T12:00:00.000Z"),
        matchedMessages: [],
        isSubagent: false,
        ...overrides,
    };
}

describe("history TTY table", () => {
    // Regression test: tools claude history hid the project, so a GenesisPlayground
    // session id looked like it belonged to the current GenesisTools checkout.
    it("prints each session's project so two repos stay distinct", () => {
        expect([...HISTORY_TABLE_HEADERS]).toEqual(["ID", "PROJECT", "TITLE", "BRANCH", "DATE", "STATUS"]);

        const projectCol = HISTORY_TABLE_HEADERS.indexOf("PROJECT");
        const playground = historyTablePlainRow(
            result({
                sessionId: "cb09c025-0657-4f49-bae6-b5aa23b8e37b",
                project: "GenesisPlayground",
                customTitle: "tooltip",
                gitBranch: "feat/2026-08-27-enhancements",
            })
        );
        const tools = historyTablePlainRow(
            result({
                sessionId: "e68d8436-3fa0-44b3-8526-1d8435af7e3b",
                project: "GenesisTools",
                customTitle: "resume miss",
                gitBranch: "feat/2026-08-24-enhancements",
            })
        );

        expect(playground[0]).toBe("cb09c025");
        expect(playground[projectCol]).toBe("GenesisPlayground");
        expect(tools[0]).toBe("e68d8436");
        expect(tools[projectCol]).toBe("GenesisTools");
    });
});
