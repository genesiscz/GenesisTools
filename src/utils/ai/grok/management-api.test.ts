import { afterEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { GrokManagementClient } from "./management-api";

describe("grok management-api", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("posts team usage to management API", async () => {
        let capturedUrl = "";
        let capturedMethod = "";

        globalThis.fetch = (async (input, init) => {
            capturedUrl = String(input);
            capturedMethod = init?.method ?? "GET";
            return new Response(SafeJSON.stringify({ usage: [] }), { status: 200 });
        }) as typeof fetch;

        const client = new GrokManagementClient("mgmt-key", "https://management-api.x.ai/v1");
        const result = await client.getTeamUsage({ teamId: "team-1" });

        expect(capturedMethod).toBe("POST");
        expect(capturedUrl).toContain("/billing/teams/team-1/usage");
        expect(result).toEqual({ usage: [] });
    });
});
