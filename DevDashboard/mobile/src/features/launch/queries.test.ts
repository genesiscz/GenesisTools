import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_LAUNCH } from "@/api/fixtures/launch";
import {
    chosenAccount,
    filterRepos,
    headroomLine,
    launchKey,
    launchQuery,
    startAgent,
    suggestedAccount,
} from "@/features/launch/queries";

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

    it("keeps a picked account through a refetch of the options, and drops it for another agent or a gone account", () => {
        const [claude, codex] = MOCK_LAUNCH.agents;
        const pick = { agentId: "claude", name: "personal" };
        // A refetch brings new headroom numbers in a new object: the pick stands.
        const refetched = { ...claude, accounts: claude.accounts.map((account) => ({ ...account, sessions: 5 })) };

        expect(chosenAccount(claude, null)).toBe("work");
        expect(chosenAccount(refetched, pick)).toBe("personal");
        expect(chosenAccount(codex, pick)).toBeNull();
        expect(chosenAccount({ ...claude, accounts: claude.accounts.filter((a) => a.name !== "personal") }, pick)).toBe("work");
    });

    it("reuses an unanswered start's key only for the same body", () => {
        const input = { agent: "claude", account: "work", repo: "shop", prompt: "fix the cart" };
        const pending = { input, idempotencyKey: "k-first" };
        let fresh = 0;
        const next = () => `k-new-${++fresh}`;

        expect(launchKey(null, input, next)).toBe("k-new-1");
        expect(launchKey(pending, { ...input }, next)).toBe("k-first");
        expect(launchKey(pending, { ...input, repo: "blog" }, next)).toBe("k-new-2");
        expect(launchKey(pending, { ...input, account: "personal" }, next)).toBe("k-new-3");
        expect(launchKey(pending, { ...input, prompt: undefined }, next)).toBe("k-new-4");
    });
});
