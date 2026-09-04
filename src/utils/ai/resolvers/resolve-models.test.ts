import { describe, expect, test } from "bun:test";
import { byId, byProvider, type CatalogEntry } from "../catalog";
import { toModelInfo } from "./resolve-models";

function entry(id: string): CatalogEntry {
    const found = byId(id);

    if (!found) {
        throw new Error(`catalog is missing ${id}, which this test depends on`);
    }

    return found;
}

describe("toModelInfo", () => {
    test("carries the catalog's id, display name and window", () => {
        const info = toModelInfo(entry("claude-opus-5"));

        expect(info.id).toBe("claude-opus-5");
        expect(info.name).toBe("Claude Opus 5");
        expect(info.contextWindow).toBe(1_000_000);
        expect(info.provider).toBe("anthropic");
    });

    test("translates image modality to the `vision` feature pickers filter on", () => {
        expect(toModelInfo(entry("claude-opus-5")).capabilities).toContain("vision");
        // xAI text-only models must not claim it.
        expect(toModelInfo(entry("grok-3-mini")).capabilities).not.toContain("vision");
    });

    test("translates thinking mode to the `reasoning` feature", () => {
        expect(toModelInfo(entry("claude-opus-5")).capabilities).toContain("reasoning");
        expect(toModelInfo(entry("claude-haiku-4-5-20251001")).capabilities).not.toContain("reasoning");
    });

    test("drops task capabilities any chat model implies", () => {
        const capabilities = toModelInfo(entry("claude-opus-5")).capabilities;

        expect(capabilities).toContain("chat");
        expect(capabilities).not.toContain("summarize");
        expect(capabilities).not.toContain("translate");
    });

    /**
     * `--caps functions` filters on this. When the catalog replaced KNOWN_MODELS
     * the claim vanished with it, because nothing in `CatalogEntry` recorded
     * tool support; `flags.tools` is that record.
     */
    test("emits function-calling for models the catalog flags as tool-capable", () => {
        expect(toModelInfo(entry("claude-opus-5")).capabilities).toContain("function-calling");
        expect(toModelInfo(entry("gpt-5.5")).capabilities).toContain("function-calling");
        expect(toModelInfo(entry("grok-4.5")).capabilities).toContain("function-calling");
    });

    test("does not claim tool support the catalog never stated", () => {
        const unflagged: CatalogEntry = { ...entry("claude-opus-5"), flags: undefined };

        expect(toModelInfo(unflagged).capabilities).not.toContain("function-calling");
    });

    test("uses the Anthropic family as the category ModelResolver matches on", () => {
        expect(toModelInfo(entry("claude-opus-5")).category).toBe("opus");
        expect(toModelInfo(entry("claude-haiku-4-5-20251001")).category).toBe("haiku");
    });

    test("passes the catalog list price through", () => {
        expect(toModelInfo(entry("claude-opus-5")).pricing?.inputPer1M).toBe(5);
    });

    /**
     * The regression this phase exists to prevent. `KNOWN_MODELS` listed five
     * Anthropic models topping out at Opus 4.6, so every resolver-backed picker
     * hid the current generation. Resolvers now read the catalog.
     */
    test("the Anthropic list resolvers read reaches the current generation", () => {
        const ids = byProvider("anthropic").map((model) => model.id);

        expect(ids).toContain("claude-opus-5");
        expect(ids).toContain("claude-sonnet-5");
        expect(ids).toContain("claude-fable-5");
        expect(ids).toContain("claude-fable-5-1");
    });
});
