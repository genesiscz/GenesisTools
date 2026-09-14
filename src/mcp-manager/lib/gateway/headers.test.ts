import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "../auth/constants.ts";
import { headersToClient, headersToUpstream, localTokenMatches, loopbackHostOk } from "./headers.ts";

describe("gateway headers", () => {
    test("loopback hosts pass, others fail", () => {
        expect(loopbackHostOk("127.0.0.1:8318")).toBe(true);
        expect(loopbackHostOk("localhost")).toBe(true);
        expect(loopbackHostOk("evil.example")).toBe(false);
    });

    test("local token must match exactly", () => {
        const req = new Request("http://127.0.0.1/mcp/rohlik", {
            headers: { [GATEWAY_HEADER]: "abc" },
        });

        expect(localTokenMatches(req, "abc")).toBe(true);
        expect(localTokenMatches(req, "nope")).toBe(false);
        expect(localTokenMatches(new Request("http://127.0.0.1/mcp/rohlik"), "abc")).toBe(false);
    });

    test("strips local header and inbound Authorization, sets upstream Bearer", () => {
        const req = new Request("http://127.0.0.1/mcp/rohlik", {
            headers: {
                [GATEWAY_HEADER]: "local",
                Authorization: "Bearer stolen-upstream",
                Accept: "application/json",
            },
        });
        const out = headersToUpstream(req, "real-access");

        expect(out.get("Authorization")).toBe("Bearer real-access");
        expect(out.get(GATEWAY_HEADER)).toBeNull();
        expect(out.get("Accept")).toBe("application/json");
    });

    test("strips WWW-Authenticate and Set-Cookie from upstream", () => {
        const upstream = new Headers({
            "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.rohlik.cz/.well-known/oauth-protected-resource/mcp"',
            "mcp-session-id": "sess-1",
            "Set-Cookie": "sid=1",
            "Content-Type": "text/event-stream",
        });
        const out = headersToClient(upstream);

        expect(out.get("WWW-Authenticate")).toBeNull();
        expect(out.get("Set-Cookie")).toBeNull();
        expect(out.get("mcp-session-id")).toBe("sess-1");
        expect(out.get("Content-Type")).toBe("text/event-stream");
    });
});
