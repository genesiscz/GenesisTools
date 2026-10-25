import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { captureOut } from "@genesiscz/utils/test/capture-out";
import { type AccountListRow, displayAccountsTable, displayAccountTestResult, displayModelsTable } from "./display";
import type { AiProxyAccountConfig, ProxyModelMeta } from "./types";

function model(overrides: Partial<ProxyModelMeta> = {}): ProxyModelMeta {
    return {
        proxyId: "work/xai/grok-4",
        accountName: "work",
        providerSlug: "xai",
        upstreamId: "grok-4",
        provider: "xai-api-key",
        baseUrl: "https://api.example.com/v1",
        visibility: "high",
        speed: "fast",
        thinking: "reasoning",
        contextWindow: 256_000,
        inputModalities: ["text", "image"],
        billingPlane: "api-key",
        source: "api-catalog",
        probeStatus: "ok",
        object: "model",
        created: 0,
        owned_by: "xai",
        ...overrides,
    };
}

function account(overrides: Partial<AiProxyAccountConfig> = {}): AiProxyAccountConfig {
    return { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true, ...overrides };
}

function row(overrides: Partial<AiProxyAccountConfig> = {}, modelCount = 4): AccountListRow {
    return { account: account(overrides), modelCount };
}

let realArgv: string[];

beforeEach(() => {
    // suggestCommand rebuilds the hint from argv, so pin it to a bare `tools` call.
    realArgv = process.argv;
    process.argv = ["bun", "tools"];
});

afterEach(() => {
    process.argv = realArgv;
});

describe("displayModelsTable", () => {
    it("tells the user how to get models when the catalog is empty", () => {
        const text = captureOut(() => displayModelsTable([]));

        expect(text).toContain("Proxy Models");
        expect(text).toContain("No models in catalog.");
        expect(text).toContain("Next:");
        expect(text).toContain("tools ai-proxy accounts list");
        expect(text).toContain("tools ai-proxy config detect");
        expect(text).not.toContain("PROXY ID");
    });

    it("prints a row per model with visibility, speed, thinking, context window and modalities", () => {
        const text = captureOut(() => displayModelsTable([model()]));

        expect(text).toMatch(
            /work\/xai\/grok-4\s+│\s+high\s+│\s+fast\s+│\s+reasoning\s+│\s+256\.0K\s+│\s+t\+i\s+│\s+● ok/
        );
        expect(text).toContain("1 model");
        expect(text).not.toContain("1 models");
    });

    it("shows a dash for an unknown context window and unknown input modalities", () => {
        const text = captureOut(() =>
            displayModelsTable([model({ contextWindow: undefined, inputModalities: undefined })])
        );
        const empty = captureOut(() => displayModelsTable([model({ inputModalities: [] })]));

        expect(text).toMatch(/fast\s+│\s+reasoning\s+│\s+—\s+│\s+—\s+│\s+● ok/);
        expect(empty).toMatch(/256\.0K\s+│\s+—\s+│/);
    });

    it("prints a small context window as a plain number and a million-token one in M", () => {
        const text = captureOut(() =>
            displayModelsTable([
                model({ proxyId: "a/x/small", contextWindow: 512 }),
                model({ proxyId: "a/x/huge", contextWindow: 2_000_000 }),
            ])
        );

        expect(text).toMatch(/a\/x\/small.*│\s+512\s+│/);
        expect(text).toMatch(/a\/x\/huge.*│\s+2\.0M\s+│/);
    });

    it("renders every visibility, speed and thinking class by its own word", () => {
        const text = captureOut(() =>
            displayModelsTable([
                model({ proxyId: "m/1", visibility: "high", speed: "fast", thinking: "none" }),
                model({ proxyId: "m/2", visibility: "medium", speed: "medium", thinking: "optional" }),
                model({ proxyId: "m/3", visibility: "low", speed: "slow", thinking: "multi-agent" }),
            ])
        );

        expect(text).toMatch(/m\/1\s+│\s+high\s+│\s+fast\s+│\s+none\s+│/);
        expect(text).toMatch(/m\/2\s+│\s+medium\s+│\s+medium\s+│\s+optional\s+│/);
        expect(text).toMatch(/m\/3\s+│\s+low\s+│\s+slow\s+│\s+multi-agent\s+│/);
    });

    it("labels each probe result and counts them in the summary line", () => {
        const text = captureOut(() =>
            displayModelsTable([
                model({ proxyId: "m/ok", probeStatus: "ok" }),
                model({ proxyId: "m/fail", probeStatus: "fail", accountName: "side" }),
                model({ proxyId: "m/skip", probeStatus: "skipped" }),
                model({ proxyId: "m/none", probeStatus: undefined }),
            ])
        );

        expect(text).toMatch(/m\/ok.*● ok/);
        expect(text).toMatch(/m\/fail.*● fail/);
        expect(text).toMatch(/m\/skip.*● skip/);
        expect(text).toMatch(/m\/none.*n\/a/);
        expect(text).toContain("4 models  ·  probe 1 ok · 1 fail · 1 skip · 1 n/a");
    });

    it("omits the skip and n/a counts when no model has them, and shows 0 fail", () => {
        const text = captureOut(() => displayModelsTable([model(), model({ proxyId: "work/xai/grok-3" })]));

        expect(text).toContain("2 models  ·  probe 2 ok · 0 fail");
        expect(text).not.toContain("skip ·");
        expect(text).not.toMatch(/\d+ n\/a/);
    });

    it("points at the failing account and the re-probe command when a probe failed", () => {
        const text = captureOut(() =>
            displayModelsTable([model(), model({ proxyId: "side/grok/old", accountName: "side", probeStatus: "fail" })])
        );

        expect(text).toContain("Debug tools ai-proxy accounts test side");
        expect(text).toContain("tools ai-proxy internal update-models");
        expect(text).toContain("re-probes Grok catalog only");
        expect(text).toContain("Grok fail rows are legacy dead ids.");
    });

    it("points at the account list and status when every probe passed", () => {
        const text = captureOut(() => displayModelsTable([model()]));

        expect(text).toContain("Debug tools ai-proxy accounts list");
        expect(text).toContain("tools ai-proxy accounts test <name>");
        expect(text).toContain("tools ai-proxy status");
        expect(text).not.toContain("internal update-models");
    });

    it("explains every column and suggests narrower listings", () => {
        const text = captureOut(() => displayModelsTable([model()]));

        for (const column of ["PROXY ID", "VIS", "SPEED", "THINK", "CTX", "MODAL", "PROBE"]) {
            expect(text).toContain(column);
        }

        expect(text).toContain("tools ai-proxy models --visibility high");
        expect(text).toContain("tools ai-proxy models --provider grok");
        expect(text).toContain("tools ai-proxy models --json");
    });
});

describe("displayAccountsTable", () => {
    it("tells the user how to add accounts when there are none", () => {
        const text = captureOut(() => displayAccountsTable([]));

        expect(text).toContain("Proxy Accounts");
        expect(text).toContain("No accounts configured.");
        expect(text).toContain("tools ai-proxy config detect");
        expect(text).toContain("tools ai-proxy config init");
        expect(text).not.toContain("SLUG");
    });

    it("prints a row per account with its slug, provider, enabled state and model count", () => {
        const text = captureOut(() => displayAccountsTable([row()]));

        expect(text).toMatch(/work\s+│\s+xai\s+│\s+xai-api-key\s+│\s+● yes\s+│\s+—\s+│\s+4\s+│\s+—/);
        expect(text).toContain("1 account  ·  1 enabled");
        expect(text).not.toContain("1 accounts");
    });

    it("shows a Codex account's failover: off by default, with any list it would use", () => {
        const codex = { provider: "openai-subscription", providerSlug: "codex" } as const;
        const text = captureOut(() =>
            displayAccountsTable([
                row({ ...codex, name: "plain" }),
                row({ ...codex, name: "listed", openaiSub: { failoverAccountNames: ["backup"] } }),
                row({ ...codex, name: "moving", failover: true, openaiSub: { failoverAccountNames: ["backup"] } }),
            ])
        );

        expect(text).toMatch(/plain\s+│.*│\s+off\s+│/);
        expect(text).toMatch(/listed\s+│.*│\s+off \(list: backup\)\s+│/);
        expect(text).toMatch(/moving\s+│.*│\s+on → backup\s+│/);
    });

    it("explains why an account lists no models", () => {
        const text = captureOut(() =>
            displayAccountsTable([
                row({ name: "off", enabled: false }, 3),
                row({ name: "keyless", provider: "xai-api-key" }, 0),
                row({ name: "claude", provider: "anthropic-subscription", providerSlug: "claude" }, 0),
            ])
        );

        expect(text).toMatch(/off\s+│.*● no\s+│\s+—\s+│\s+3\s+│\s+disabled in config/);
        expect(text).toMatch(/keyless\s+│.*● yes\s+│\s+—\s+│\s+0\s+│\s+no models \(check API key \/ GET \/models\)/);
        expect(text).toMatch(/claude\s+│.*● yes\s+│\s+—\s+│\s+0\s+│\s+enabled but catalog empty/);
    });

    it("counts the enabled accounts and the ones with no models, and adds a tip only for the latter", () => {
        const withEmpty = captureOut(() =>
            displayAccountsTable([row({ name: "a" }, 2), row({ name: "b", enabled: false }, 0), row({ name: "c" }, 5)])
        );
        const allListed = captureOut(() => displayAccountsTable([row({ name: "a" }, 2), row({ name: "b" }, 1)]));

        expect(withEmpty).toContain("3 accounts  ·  2 enabled  ·  1 with 0 models");
        expect(withEmpty).toContain("MODELS=0 → check NOTE, then accounts test <name>");
        expect(allListed).toContain("2 accounts  ·  2 enabled");
        expect(allListed).not.toContain("with 0 models");
        expect(allListed).not.toContain("MODELS=0");
    });

    it("builds the next-step commands from the first account", () => {
        const text = captureOut(() => displayAccountsTable([row({ name: "work" }), row({ name: "side" })]));

        expect(text).toContain("Next  tools ai-proxy accounts test work");
        expect(text).toContain("tools ai-proxy usage --account work");
        expect(text).toContain("Debug tools ai-proxy config show");
        expect(text).not.toContain("accounts test side");
    });

    it("shows the longest provider name in full, within the 28 character column limit", () => {
        const provider = "github-copilot-subscription";
        const text = captureOut(() => displayAccountsTable([row({ provider, providerSlug: "copilot" })]));

        expect(provider.length).toBeLessThanOrEqual(28);
        expect(text).toMatch(/copilot\s+│\s+github-copilot-subscription\s+│/);
    });
});

describe("displayAccountTestResult", () => {
    it("reports the provider, slug, usage summary and model count", () => {
        const text = captureOut(() =>
            displayAccountTestResult({
                name: "work",
                provider: "xai-api-key",
                providerSlug: "xai",
                summary: "42 / 100 requests used",
                modelCount: 7,
            })
        );

        expect(text).toContain("Account: work");
        expect(text).toContain("upstream ping");
        expect(text).toMatch(/Provider\s+xai-api-key/);
        expect(text).toMatch(/Slug\s+xai/);
        expect(text).toMatch(/Usage\s+42 \/ 100 requests used/);
        expect(text).toMatch(/Models\s+7/);
        expect(text).not.toContain("Sample");
    });

    it("lists at most the first five sample models", () => {
        const text = captureOut(() =>
            displayAccountTestResult({
                name: "work",
                provider: "xai-api-key",
                providerSlug: "xai",
                summary: "ok",
                modelCount: 7,
                modelsSample: ["m1", "m2", "m3", "m4", "m5", "m6", "m7"],
            })
        );

        expect(text).toMatch(/Sample\s+m1, m2, m3, m4, m5\n/);
        expect(text).not.toContain("m6");
    });

    it("shows no sample row for an empty sample and suggests the follow-up commands", () => {
        const text = captureOut(() =>
            displayAccountTestResult({
                name: "work",
                provider: "grok-subscription",
                providerSlug: "grok",
                summary: "ok",
                modelCount: 0,
                modelsSample: [],
            })
        );

        expect(text).not.toContain("Sample");
        expect(text).toMatch(/Models\s+0/);
        expect(text).toContain("tools ai-proxy models --provider grok");
        expect(text).toContain("tools ai-proxy usage --account work");
        expect(text).toContain("tools ai-proxy status");
    });
});
