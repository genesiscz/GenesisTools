import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    codexModelsCachePath,
    describeCodexEfforts,
    mergeCodexModelRecords,
    readCodexModelsCache,
    resolveCodexEffort,
} from "./codex-models";
import { OPENAI_SUB_STATIC_CATALOG, resolveOpenAiSubModel, type WhamModelRecord } from "./sub-models";

const SOL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function record(slug: string, fields: Partial<WhamModelRecord> = {}): WhamModelRecord {
    return { slug, displayName: slug, contextWindow: 272_000, visibility: "list", ...fields };
}

describe("mergeCodexModelRecords", () => {
    it("takes each field from the first source that has it: live, then the CLI cache, then static", () => {
        const merged = mergeCodexModelRecords({
            live: [record("m", { contextWindow: 500_000, supportedEfforts: SOL_EFFORTS })],
            cache: [record("m", { contextWindow: 400_000, effectiveContextWindowPercent: 95, defaultEffort: "low" })],
            fallback: [record("m", { compHash: "3000", defaultEffort: "medium", useResponsesLite: true })],
        }).get("m");

        expect(merged).toMatchObject({
            window: 500_000,
            efforts: SOL_EFFORTS,
            usablePercent: 95,
            defaultEffort: "low",
            compHash: "3000",
            useResponsesLite: true,
        });
        expect(merged?.sources).toMatchObject({
            window: "live",
            efforts: "live",
            usablePercent: "cache",
            defaultEffort: "cache",
            compHash: "static",
            compactPercent: "default",
        });
    });

    it("derives the usable and compact windows by percent, and an override wins over every source", () => {
        const plain = mergeCodexModelRecords({ live: [record("m", { contextWindow: 500_000 })], fallback: [] }).get(
            "m"
        );

        // codex-rs: 95% usable when the record names no percent, compaction at 90%.
        expect(plain).toMatchObject({
            usablePercent: 95,
            compactPercent: 90,
            usableTokens: 475_000,
            compactTokens: 450_000,
        });

        const limited = mergeCodexModelRecords({
            live: [record("m", { contextWindow: 500_000, autoCompactTokenLimit: 300_000 })],
            fallback: [],
        }).get("m");

        // A catalog compaction limit may only lower the 90% point.
        expect(limited?.compactTokens).toBe(300_000);

        const overridden = mergeCodexModelRecords({
            live: [record("m", { contextWindow: 500_000, defaultEffort: "low" })],
            fallback: [],
            overrides: { m: { window: 400_000, usablePercent: 92, compactPercent: 80, defaultEffort: "high" } },
        }).get("m");

        expect(overridden).toMatchObject({
            window: 400_000,
            usableTokens: 368_000,
            compactTokens: 320_000,
            defaultEffort: "high",
        });
        expect(overridden?.sources).toMatchObject({
            window: "override",
            usablePercent: "override",
            compactPercent: "override",
            defaultEffort: "override",
        });
    });

    it("keeps the static GPT-6 records complete enough to work with no live list and no cache", () => {
        const merged = mergeCodexModelRecords({});

        expect(merged.get("gpt-6.1-sol")).toMatchObject({
            window: 500_000,
            usableTokens: 475_000,
            efforts: SOL_EFFORTS,
            defaultEffort: "low",
            multiAgentReasoningEffort: "xhigh",
            useResponsesLite: true,
            compHash: "3000",
        });
        expect(merged.get("gpt-6-luna")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(OPENAI_SUB_STATIC_CATALOG.some((entry) => entry.slug === "gpt-6-sol")).toBe(true);
        expect(resolveOpenAiSubModel("sol6")).toBe("gpt-6-sol");
        expect(resolveOpenAiSubModel("sol")).toBe("gpt-6.1-sol");
    });
});

describe("resolveCodexEffort", () => {
    const catalog = mergeCodexModelRecords({});
    const model = (slug: string) => {
        const info = catalog.get(slug);

        if (!info) {
            throw new Error(`no static record for ${slug}`);
        }

        return info;
    };

    it("passes a listed effort unchanged, max included", () => {
        expect(resolveCodexEffort(model("gpt-6.1-sol"), "max")).toEqual({ ok: true, effort: "max" });
        expect(resolveCodexEffort(model("gpt-6.1-sol"), "XHigh")).toEqual({ ok: true, effort: "xhigh" });
    });

    it("maps ultra the way codex-rs does: the multi-agent effort, else max, else the strongest other level", () => {
        expect(resolveCodexEffort(model("gpt-6.1-sol"), "ultra")).toEqual({
            ok: true,
            effort: "xhigh",
            mappedFrom: "ultra",
        });
        expect(resolveCodexEffort(model("gpt-6.1-terra"), "ultra")).toEqual({
            ok: true,
            effort: "xhigh",
            mappedFrom: "ultra",
        });
        expect(resolveCodexEffort(model("gpt-6-sol"), "ultra")).toEqual({
            ok: true,
            effort: "max",
            mappedFrom: "ultra",
        });

        const noMax = { slug: "m", efforts: ["low", "high", "ultra"], multiAgentReasoningEffort: "max" };
        expect(resolveCodexEffort(noMax, "ultra")).toEqual({ ok: true, effort: "high", mappedFrom: "ultra" });
    });

    it("refuses an effort the model does not list, naming the allowed ones", () => {
        expect(resolveCodexEffort(model("gpt-6-luna"), "ultra")).toEqual({
            ok: false,
            allowed: ["low", "medium", "high", "xhigh", "max"],
            message: 'gpt-6-luna has no reasoning effort "ultra". Allowed: low, medium, high, xhigh, max.',
        });
        expect(describeCodexEfforts(model("gpt-6.1-sol"))).toBe("low, medium, high, xhigh, max, ultra (runs as xhigh)");
    });
});

describe("readCodexModelsCache", () => {
    it("reads the Codex CLI cache schema and answers an empty list for a missing file", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-codex-models-"));
        const path = join(dir, "models_cache.json");
        writeFileSync(
            path,
            SafeJSON.stringify({
                fetched_at: "2026-10-25T20:19:22Z",
                models: [
                    {
                        slug: "gpt-x",
                        display_name: "X",
                        context_window: 500_000,
                        visibility: "list",
                        supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "max" }],
                        default_reasoning_level: "low",
                        effective_context_window_percent: 95,
                        auto_compact_token_limit: null,
                        multi_agent_reasoning_effort: null,
                        comp_hash: "3000",
                    },
                    { slug: "broken" },
                ],
            })
        );

        expect(readCodexModelsCache(path)).toEqual([
            expect.objectContaining({
                slug: "gpt-x",
                contextWindow: 500_000,
                supportedEfforts: ["low", "max"],
                defaultEffort: "low",
                effectiveContextWindowPercent: 95,
                autoCompactTokenLimit: undefined,
                multiAgentReasoningEffort: undefined,
                compHash: "3000",
            }),
        ]);
        expect(readCodexModelsCache(join(dir, "missing.json"))).toEqual([]);
    });

    it("never reads the real Codex home under test: the preload points the cache at an empty folder", () => {
        expect(codexModelsCachePath()).toContain("gt-test-codex-models-");
    });
});
