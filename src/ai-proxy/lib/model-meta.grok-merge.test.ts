import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";

const root = mkdtempSync(join(tmpdir(), "gt-grok-merge-"));
const catalogPath = join(root, "models-catalog.json");

mock.module("@app/ai-proxy/lib/storage", () => ({
    getAiProxyStorage: () => ({ modelsCatalogPath: () => catalogPath }),
}));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

/** A grok home holding just the picker cache, addressed via the account's authPath. */
function grokHome(name: string, models: Record<string, unknown>): string {
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "models_cache.json"), SafeJSON.stringify({ models }) ?? "{}");
    return join(home, "auth.json");
}

function accountFor(name: string, authPath: string): AiProxyAccountConfig {
    return {
        name,
        provider: "grok-subscription",
        providerSlug: "grok",
        enabled: true,
        grok: { authPath },
    } as AiProxyAccountConfig;
}

describe("listGrokProxyModels merge policy", () => {
    it("lets a live entry win, drops failed probes and uncurated ids, and stays account-scoped", async () => {
        const { listGrokProxyModels } = await import("@app/ai-proxy/lib/model-meta");

        const authA = grokHome("account-a", {
            // Live wins over the static hint for the same id.
            "grok-4.6": { info: { context_window: 424_242, supported_in_api: true } },
            // Curated, live-only — it must be advertised without a repo edit.
            "grok-4.5": { info: { context_window: 111, supported_in_api: true } },
            // The picker ships entries it does not want offered.
            "grok-hidden-one": { info: { hidden: true } },
            // Uncurated ids never reach the picker.
            "grok-3-mini": { info: { supported_in_api: true } },
        });
        const authB = grokHome("account-b", {
            "grok-4.5": { info: { context_window: 999, supported_in_api: true } },
        });

        writeFileSync(
            catalogPath,
            SafeJSON.stringify({
                accounts: [
                    {
                        accountName: "account-a",
                        provider: "grok-subscription",
                        probedModels: [
                            { id: "grok-4-fast-reasoning", probeStatus: "fail" },
                            { id: "grok-4-fast", probeStatus: "ok" },
                        ],
                    },
                ],
            }) ?? "{}"
        );

        const a = listGrokProxyModels(accountFor("account-a", authA), "https://example.invalid/v1");
        const byUpstream = new Map(a.map((model) => [model.upstreamId, model]));

        // 1. Live beats the static catalog's guess for the same id.
        expect(byUpstream.get("grok-4.6")?.contextWindow).toBe(424_242);
        // 2. A failed probe is never advertised.
        expect(byUpstream.has("grok-4-fast-reasoning")).toBe(false);
        // 3. A successful probe is.
        expect(byUpstream.has("grok-4-fast")).toBe(true);
        // 4. Hidden and uncurated entries stay out.
        expect(byUpstream.has("grok-hidden-one")).toBe(false);
        expect(byUpstream.has("grok-3-mini")).toBe(false);

        // 5. Account scoping: reading the process-wide cache would let account B's
        // numbers appear here, advertising models this account may not call.
        const b = listGrokProxyModels(accountFor("account-b", authB), "https://example.invalid/v1");
        expect(byUpstream.get("grok-4.5")?.contextWindow).toBe(111);
        expect(b.find((model) => model.upstreamId === "grok-4.5")?.contextWindow).toBe(999);
    });
});
