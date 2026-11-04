import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_LAUNCH } from "@/api/fixtures/launch";
import { filterRepos, headroomLine, launchQuery, startAgent, suggestedAccount } from "@/features/launch/queries";

describe("the New agent sheet", () => {
    it("reads the options and sends a start through the real client", async () => {
        const options = await launchQuery(fixtureDashboardClient).queryFn?.({} as never);
        const receipt = await startAgent(fixtureDashboardClient, {
            agent: "claude",
            repo: "shop",
            account: "work",
            idempotencyKey: "k1",
        });

        expect(options).toEqual(MOCK_LAUNCH);
        expect(receipt.started).toBe(false);
    });

    it("picks the best usable account, never a blocked one", () => {
        const [claude, codex, grok] = MOCK_LAUNCH.agents;

        expect(suggestedAccount(claude)?.name).toBe("work");
        expect(suggestedAccount(codex)).toBeUndefined();
        expect(suggestedAccount(grok)).toBeUndefined();
        expect(headroomLine(claude.accounts[0])).toBe("5h 62% · long 40% · 2 running");
        expect(headroomLine(claude.accounts[2])).toBe("no usage reading yet");
        expect(filterRepos(MOCK_LAUNCH.repos, "Sh")).toEqual(["shop"]);
    });
});
