import { describe, expect, it } from "bun:test";
import { buildCliProxyHeaders } from "./headers";

describe("grok headers", () => {
    it("builds required cli proxy headers", () => {
        const headers = buildCliProxyHeaders({
            token: "jwt-token",
            modelOverride: "grok-composer-2.5-fast",
            clientVersion: "0.2.60",
        });

        expect(headers.Authorization).toBe("Bearer jwt-token");
        expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
        expect(headers["x-grok-client-version"]).toBe("0.2.60");
        expect(headers["x-grok-model-override"]).toBe("grok-composer-2.5-fast");
    });
});
