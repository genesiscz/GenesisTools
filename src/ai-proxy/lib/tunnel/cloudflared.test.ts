import { describe, expect, it } from "bun:test";
import {
    buildAiProxyIngressBlock,
    ingressPathPattern,
    mergeAiProxyIngress,
    mergeTelegramWebhookIngress,
    parseTunnelNameFromConfig,
    telegramWebhookPathPattern,
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

const LIVE_SHAPE_CONFIG = `tunnel: home-tunnel
credentials-file: /var/empty/id.json
protocol: http2

ingress:
  # Old webhook listener -> local webhook server
  - hostname: proxy.example.dev
    path: /telegram-webhook
    service: http://127.0.0.1:8787


  # dashboard catch-all
  # ai-proxy (managed by tools ai-proxy)
  - hostname: proxy.example.dev
    path: ^/ai/(v1|health)(/|$)
    service: http://127.0.0.1:8317
  - hostname: proxy.example.dev
    service: http://127.0.0.1:3042

  # Catch-all (must be last): anything unmatched gets 404
  - service: http_status:404
`;

const WEBHOOK_RULE = { hostname: "proxy.example.dev", path: "/telegram-webhook", port: 8319 };

describe("telegram webhook ingress", () => {
    it("anchors the path at both ends, so only the webhook itself matches", () => {
        const pattern = new RegExp(telegramWebhookPathPattern("/telegram-webhook"));

        expect(pattern.test("/telegram-webhook")).toBe(true);
        expect(pattern.test("/telegram-webhook/")).toBe(false);
        expect(pattern.test("/telegram-webhook-stats")).toBe(false);
        expect(pattern.test("/api/telegram-webhook")).toBe(false);
        expect(pattern.test("/x/telegram-webhook")).toBe(false);
        expect(new RegExp(telegramWebhookPathPattern("/a.b")).test("/aXb")).toBe(false);
    });

    it("replaces the old unanchored rule where it stands and touches nothing else", () => {
        const merged = mergeTelegramWebhookIngress(LIVE_SHAPE_CONFIG, WEBHOOK_RULE);

        expect(merged.changed).toBe(true);
        expect(merged.removedLegacyRules).toBe(1);
        expect(merged.yaml).toBe(`tunnel: home-tunnel
credentials-file: /var/empty/id.json
protocol: http2

ingress:
  # telegram-bot webhook (managed by tools telegram-bot webhook tunnel)
  - hostname: proxy.example.dev
    path: ^/telegram-webhook$
    service: http://127.0.0.1:8319


  # dashboard catch-all
  # ai-proxy (managed by tools ai-proxy)
  - hostname: proxy.example.dev
    path: ^/ai/(v1|health)(/|$)
    service: http://127.0.0.1:8317
  - hostname: proxy.example.dev
    service: http://127.0.0.1:3042

  # Catch-all (must be last): anything unmatched gets 404
  - service: http_status:404
`);
    });

    it("is idempotent", () => {
        const once = mergeTelegramWebhookIngress(LIVE_SHAPE_CONFIG, WEBHOOK_RULE);
        const twice = mergeTelegramWebhookIngress(once.yaml, WEBHOOK_RULE);

        expect(twice.changed).toBe(false);
        expect(twice.yaml).toBe(once.yaml);
    });

    it("moves a managed rule to a new port in place", () => {
        const once = mergeTelegramWebhookIngress(LIVE_SHAPE_CONFIG, WEBHOOK_RULE);
        const moved = mergeTelegramWebhookIngress(once.yaml, { ...WEBHOOK_RULE, port: 8400 });

        expect(moved.changed).toBe(true);
        expect(moved.yaml).toContain("service: http://127.0.0.1:8400");
        expect(moved.yaml).not.toContain("8319");
        expect(moved.yaml.match(/path: \^\/telegram-webhook\$/g)?.length).toBe(1);
    });

    it("adds the rule in front of the hostname catch-all when the config has none", () => {
        const bare = LIVE_SHAPE_CONFIG.replace(/ {2}# Old webhook[\s\S]*?8787\n\n\n/, "");
        const merged = mergeTelegramWebhookIngress(bare, WEBHOOK_RULE);

        expect(bare).not.toContain("8787");
        expect(merged.changed).toBe(true);
        expect(merged.removedLegacyRules).toBe(0);
        expect(merged.yaml.indexOf("path: ^/telegram-webhook$")).toBeLessThan(merged.yaml.indexOf("127.0.0.1:3042"));
        expect(merged.yaml).toContain("path: ^/ai/(v1|health)(/|$)");
    });

    it("leaves a rule for the same path on another hostname alone", () => {
        const other = LIVE_SHAPE_CONFIG.replace(
            "hostname: proxy.example.dev\n    path: /telegram-webhook",
            "hostname: other.example.dev\n    path: /telegram-webhook"
        );
        const merged = mergeTelegramWebhookIngress(other, WEBHOOK_RULE);

        expect(merged.removedLegacyRules).toBe(0);
        expect(merged.yaml).toContain("hostname: other.example.dev\n    path: /telegram-webhook");
        expect(merged.yaml).toContain("path: ^/telegram-webhook$");
    });

    it("folds duplicate rules for the webhook path into one", () => {
        const doubled = LIVE_SHAPE_CONFIG.replace(
            "  # dashboard catch-all",
            "  - hostname: proxy.example.dev\n    path: /telegram-webhook\n    service: http://127.0.0.1:9000\n  # dashboard catch-all"
        );
        const merged = mergeTelegramWebhookIngress(doubled, WEBHOOK_RULE);

        expect(merged.removedLegacyRules).toBe(2);
        expect(merged.yaml.match(/path: \^\/telegram-webhook\$/g)?.length).toBe(1);
        expect(merged.yaml).not.toContain("9000");
    });

    it("appends an ingress section to a config without one", () => {
        const merged = mergeTelegramWebhookIngress("tunnel: t\n", WEBHOOK_RULE);

        expect(merged.yaml).toBe(`tunnel: t
ingress:
  # telegram-bot webhook (managed by tools telegram-bot webhook tunnel)
  - hostname: proxy.example.dev
    path: ^/telegram-webhook$
    service: http://127.0.0.1:8319
  - service: http_status:404
`);
    });

    it("coexists with the ai-proxy merge in either order", () => {
        const aiRule = { hostname: "proxy.example.dev", basePath: "/ai", port: 8317 };
        const webhookThenAi = mergeAiProxyIngress(
            mergeTelegramWebhookIngress(LIVE_SHAPE_CONFIG, WEBHOOK_RULE).yaml,
            aiRule
        );
        const aiThenWebhook = mergeTelegramWebhookIngress(
            mergeAiProxyIngress(LIVE_SHAPE_CONFIG, aiRule).yaml,
            WEBHOOK_RULE
        );

        for (const result of [webhookThenAi.yaml, aiThenWebhook.yaml]) {
            expect(result.match(/path: \^\/telegram-webhook\$/g)?.length).toBe(1);
            expect(result.match(/path: \^\/ai\/\(v1\|health\)/g)?.length).toBe(1);
            expect(result).toContain("127.0.0.1:3042");
        }
    });
});
