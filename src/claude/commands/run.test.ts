import { describe, expect, it } from "bun:test";
import type { ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { effortError, selectProxyModels, unlistedProxyModel } from "./run";

function model(proxyId: string): ProxyModelMeta {
    const [accountName = "", providerSlug = "", ...rest] = proxyId.split("/");

    return {
        proxyId,
        accountName,
        providerSlug,
        upstreamId: rest.join("/"),
        provider: "grok-subscription",
        baseUrl: "https://example.invalid/v1",
        visibility: "high",
        speed: "medium",
        thinking: "none",
        billingPlane: "subscription",
        source: "probe",
        object: "model",
        created: 0,
        owned_by: proxyId,
    };
}

const CATALOG = [
    model("martin/grok/grok-4.5"),
    model("martin/grok/grok-4-fast"),
    model("martin/grok/grok-composer-2.5-fast"),
    model("work/xai/grok-4.6"),
    model("work/xai/grok-4.5"),
    model("openrouter/openrouter/x-ai/grok-4.6"),
];

function ids(entries: ProxyModelMeta[]): string[] {
    return entries.map((entry) => entry.proxyId);
}

describe("selectProxyModels", () => {
    it("returns the whole catalog when nothing is given", () => {
        expect(selectProxyModels(CATALOG, {})).toHaveLength(CATALOG.length);
    });

    it("scopes an account/provider prefix to that account", () => {
        expect(ids(selectProxyModels(CATALOG, { target: "martin/grok" }))).toEqual([
            "martin/grok/grok-4.5",
            "martin/grok/grok-4-fast",
            "martin/grok/grok-composer-2.5-fast",
        ]);
    });

    it("applies the model filter inside the target", () => {
        expect(ids(selectProxyModels(CATALOG, { target: "work/xai", modelSpec: "4.6" }))).toEqual([
            "work/xai/grok-4.6",
        ]);
    });

    it("returns nothing when the target does not serve the model, rather than guessing another account", () => {
        expect(selectProxyModels(CATALOG, { target: "martin/grok", modelSpec: "4.6" })).toEqual([]);
    });

    it("finds the model across accounts when no target is given", () => {
        expect(ids(selectProxyModels(CATALOG, { modelSpec: "4.6" }))).toEqual([
            "work/xai/grok-4.6",
            "openrouter/openrouter/x-ai/grok-4.6",
        ]);
    });

    it("takes an exact full proxy id", () => {
        expect(ids(selectProxyModels(CATALOG, { target: "martin/grok/grok-4.5" }))).toEqual(["martin/grok/grok-4.5"]);
    });

    it("tolerates a trailing slash on the prefix", () => {
        expect(ids(selectProxyModels(CATALOG, { target: "work/xai/" }))).toEqual([
            "work/xai/grok-4.6",
            "work/xai/grok-4.5",
        ]);
    });

    it("requires every whitespace-separated token to match", () => {
        expect(ids(selectProxyModels(CATALOG, { modelSpec: "composer fast" }))).toEqual([
            "martin/grok/grok-composer-2.5-fast",
        ]);
    });

    it("falls back to a fuzzy match when the prefix matches no account", () => {
        expect(ids(selectProxyModels(CATALOG, { target: "openrouter" }))).toEqual([
            "openrouter/openrouter/x-ai/grok-4.6",
        ]);
    });
});

describe("unlistedProxyModel", () => {
    it("passes through a full id on a known account that the catalog does not list", () => {
        // The real case: martin/grok/grok-4.6 answered chat while `ai-proxy models` hid it.
        const entry = unlistedProxyModel(CATALOG, "martin/grok/grok-4.6");

        expect(entry?.proxyId).toBe("martin/grok/grok-4.6");
        expect(entry?.upstreamId).toBe("grok-4.6");
        expect(entry?.accountName).toBe("martin");
        expect(entry?.providerSlug).toBe("grok");
        expect(entry?.probeStatus).toBeUndefined();
    });

    it("does not inherit the sibling's per-model facts", () => {
        const withCtx = CATALOG.map((entry) =>
            entry.proxyId === "martin/grok/grok-4.5"
                ? { ...entry, contextWindow: 500_000, supportsTools: false }
                : entry
        );
        const entry = unlistedProxyModel(withCtx, "martin/grok/grok-4.6");

        expect(entry?.contextWindow).toBeUndefined();
        expect(entry?.supportsTools).toBeUndefined();
        // Account-level facts DO carry over — they are properties of the account.
        expect(entry?.billingPlane).toBe("subscription");
    });

    it("keeps a multi-segment upstream id intact", () => {
        expect(unlistedProxyModel(CATALOG, "openrouter/openrouter/x-ai/grok-5")?.upstreamId).toBe("x-ai/grok-5");
    });

    it("refuses an unknown account, so a typo fails locally instead of upstream", () => {
        expect(unlistedProxyModel(CATALOG, "typo/grok/grok-4.6")).toBeNull();
        expect(unlistedProxyModel(CATALOG, "martin/typo/grok-4.6")).toBeNull();
    });

    it("refuses a bare account/provider prefix — that is not a model id", () => {
        expect(unlistedProxyModel(CATALOG, "martin/grok")).toBeNull();
    });
});

describe("effortError", () => {
    it("accepts every documented effort and an absent flag", () => {
        for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max", undefined]) {
            expect(effortError(effort)).toBeUndefined();
        }
    });

    it("names the valid values when the flag is misspelled", () => {
        // Validated before --list and before the interactive picker, so a typo
        // never costs the user a model prompt first.
        expect(effortError("xhgh")).toContain("Unknown effort");
        expect(effortError("xhgh")).toContain("xhigh");
    });
});
