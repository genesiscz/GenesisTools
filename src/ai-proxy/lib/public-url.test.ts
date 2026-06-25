import { describe, expect, it } from "bun:test";
import { buildPublicBaseUrl, buildPublicHealthUrl, resolveCursorBaseUrl } from "@app/ai-proxy/lib/public-url";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";

const cloudflaredConfig: AiProxyConfig = {
    listen: { host: "127.0.0.1", port: 8317 },
    proxyApiKey: "aipx-test",
    translation: { cursorAgent: "auto", thinking: "raw" },
    public: {
        mode: "cloudflared",
        hostname: "proxy.example.dev",
        basePath: "/ai",
        cloudflared: { tunnelName: "home-tunnel" },
    },
    accounts: [],
};

const customConfig: AiProxyConfig = {
    listen: { host: "127.0.0.1", port: 8317 },
    proxyApiKey: "aipx-test",
    translation: { cursorAgent: "auto", thinking: "raw" },
    public: {
        mode: "custom",
        baseUrl: "https://proxy.example.dev/ai",
    },
    accounts: [],
};

describe("public-url", () => {
    it("builds public Cursor base URL from cloudflared config", () => {
        expect(buildPublicBaseUrl(cloudflaredConfig)).toBe("https://proxy.example.dev/ai/v1");
        expect(buildPublicHealthUrl(cloudflaredConfig)).toBe("https://proxy.example.dev/ai/health");
        expect(resolveCursorBaseUrl(cloudflaredConfig)).toBe("https://proxy.example.dev/ai/v1");
    });

    it("normalizes custom base and health URLs", () => {
        expect(buildPublicBaseUrl(customConfig)).toBe("https://proxy.example.dev/ai/v1");
        expect(buildPublicHealthUrl(customConfig)).toBe("https://proxy.example.dev/ai/health");
        expect(resolveCursorBaseUrl(customConfig)).toBe("https://proxy.example.dev/ai/v1");
    });
});
