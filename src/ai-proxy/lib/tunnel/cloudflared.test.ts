import { describe, expect, it } from "bun:test";
import {
    buildAiProxyIngressBlock,
    ingressPathPattern,
    mergeAiProxyIngress,
    parseTunnelNameFromConfig,
} from "@app/ai-proxy/lib/tunnel/cloudflared";

const SAMPLE_CONFIG = `tunnel: home-tunnel
credentials-file: /Users/test/.cloudflared/id.json

ingress:
  - hostname: proxy.example.dev
    path: /telegram-webhook
    service: http://127.0.0.1:8787
  - hostname: proxy.example.dev
    service: http://127.0.0.1:3042
  - service: http_status:404
`;

describe("cloudflared ingress merge", () => {
    it("parses tunnel name from config", () => {
        expect(parseTunnelNameFromConfig(SAMPLE_CONFIG)).toBe("home-tunnel");
    });

    it("builds /ai ingress block", () => {
        const block = buildAiProxyIngressBlock({
            hostname: "proxy.example.dev",
            basePath: "/ai",
            port: 8317,
        });

        expect(block).toContain("path: ^/ai/(v1|health)(/|$)");
        expect(block).toContain("service: http://127.0.0.1:8317");
    });

    it("routes only the proxy's own surface, so dashboard pages and APIs under /ai stay on the dashboard", () => {
        const pattern = new RegExp(ingressPathPattern("/ai"));

        expect(pattern.test("/ai/v1/messages")).toBe(true);
        expect(pattern.test("/ai/v1")).toBe(true);
        expect(pattern.test("/ai/health")).toBe(true);
        expect(pattern.test("/ai/accounts")).toBe(false);
        expect(pattern.test("/ai")).toBe(false);
        expect(pattern.test("/api/ai/usage")).toBe(false);
        expect(pattern.test("/aiming")).toBe(false);
    });

    it("inserts ai-proxy rule before hostname catch-all and http_status:404", () => {
        const merged = mergeAiProxyIngress(SAMPLE_CONFIG, {
            hostname: "proxy.example.dev",
            basePath: "/ai",
            port: 8317,
        });

        expect(merged.changed).toBe(true);
        expect(merged.yaml).toContain("path: ^/ai/(v1|health)(/|$)");
        expect(merged.yaml.indexOf("path: ^/ai")).toBeLessThan(merged.yaml.indexOf("127.0.0.1:3042"));
        expect(merged.yaml.indexOf("path: ^/ai")).toBeLessThan(merged.yaml.indexOf("http_status:404"));
    });

    it("upgrades a legacy unanchored `path: /ai` rule in place", () => {
        const legacy = SAMPLE_CONFIG.replace(
            "  - service: http_status:404",
            `  - hostname: proxy.example.dev
    path: /ai
    service: http://127.0.0.1:8317
  - service: http_status:404`
        );

        const merged = mergeAiProxyIngress(legacy, { hostname: "proxy.example.dev", basePath: "/ai", port: 8317 });

        expect(merged.changed).toBe(true);
        expect(merged.yaml).toContain("path: ^/ai/(v1|health)(/|$)");
        expect(merged.yaml).not.toContain("path: /ai\n");
        expect(merged.yaml.match(/127\.0\.0\.1:8317/g)?.length).toBe(1);
    });

    it("replaces existing ai-proxy managed block", () => {
        const withOld = `${SAMPLE_CONFIG.replace(
            "  - service: http_status:404",
            `  # ai-proxy (managed by tools ai-proxy)
  - hostname: proxy.example.dev
    path: /v1
    service: http://127.0.0.1:8317
  - service: http_status:404`
        )}`;

        const merged = mergeAiProxyIngress(withOld, {
            hostname: "proxy.example.dev",
            basePath: "/ai",
            port: 8317,
        });

        expect(merged.yaml).toContain("path: ^/ai/(v1|health)(/|$)");
        expect(merged.yaml).not.toContain("path: /v1");
    });
});
