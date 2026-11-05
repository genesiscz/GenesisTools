import { afterAll, describe, expect, test } from "bun:test";
import { ClarityApi } from "./api.js";

const seen: string[] = [];
const server = Bun.serve({
    port: 0,
    fetch(req) {
        const token = req.headers.get("authToken") ?? "";
        seen.push(token);

        return token === "fresh" ? Response.json({ resource: { _results: [] } }) : new Response("", { status: 401 });
    },
});

afterAll(() => {
    server.stop(true);
});

class RenewingApi extends ClarityApi {
    renewals = 0;

    protected override async renewAuth(): Promise<boolean> {
        this.renewals++;
        this.replaceSession({ ...(await this.session()), authToken: "fresh" });

        return true;
    }
}

describe("ClarityApi.renewAuth", () => {
    test("a 401 renews once and repeats the request with the fresh session", async () => {
        seen.length = 0;
        const api = new RenewingApi({
            baseUrl: `http://localhost:${server.port}`,
            authToken: "stale",
            sessionId: "test",
        });

        await api.getTimesheetApp(0);

        expect(api.renewals).toBe(1);
        expect(seen).toEqual(["stale", "fresh"]);
    });

    test("the base class does not renew, so the 401 surfaces", async () => {
        const api = new ClarityApi({
            baseUrl: `http://localhost:${server.port}`,
            authToken: "stale",
            sessionId: "test",
        });

        await expect(api.getTimesheetApp(0)).rejects.toThrow("Clarity API error 401");
    });
});
