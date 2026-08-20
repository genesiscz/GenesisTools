import { describe, expect, it } from "bun:test";
import { hoistSystemMessages } from "@app/ai-proxy/lib/translators/formats/anthropic/hoist-system-messages";
import { ensureSubscriptionSystemPrefix, mergeBetas } from "./anthropic-subscription";

const PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

describe("ensureSubscriptionSystemPrefix", () => {
    it("leaves Claude Code's block array untouched — it already starts with the prefix", () => {
        // The whole point of the passthrough: flattening this array drops the
        // cache_control breakpoints, and Anthropic caches ONLY at breakpoints.
        const system = [
            { type: "text", text: PREFIX, cache_control: { type: "ephemeral" } },
            { type: "text", text: "You are an interactive agent...", cache_control: { type: "ephemeral" } },
        ];

        expect(ensureSubscriptionSystemPrefix(system)).toBe(system);
    });

    it("prepends a block when a foreign client's system lacks the prefix", () => {
        const system = [{ type: "text", text: "custom agent", cache_control: { type: "ephemeral" } }];
        const out = ensureSubscriptionSystemPrefix(system) as Array<Record<string, unknown>>;

        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ type: "text", text: PREFIX });
        // The caller's own block, cache_control intact, still present.
        expect(out[1]).toEqual(system[0]);
    });

    it("keeps the string form working for non-Anthropic-shaped callers", () => {
        expect(ensureSubscriptionSystemPrefix("be terse")).toBe(`${PREFIX}\n\nbe terse`);
        expect(ensureSubscriptionSystemPrefix(`${PREFIX}\n\nbe terse`)).toBe(`${PREFIX}\n\nbe terse`);
        expect(ensureSubscriptionSystemPrefix(undefined)).toBe(PREFIX);
    });
});

describe("hoist + prefix composition (what messages() actually applies)", () => {
    it("keeps the cached prefix at system[0] and appends the hoisted block after it", () => {
        // messages() runs hoistSystemMessages BEFORE ensureSubscriptionSystemPrefix
        // precisely so the hoisted text cannot displace the cached prefix.
        // Anthropic caches only at breakpoints, so an ordering slip here costs
        // the whole prompt cache on every request.
        const body = {
            system: [
                { type: "text", text: PREFIX, cache_control: { type: "ephemeral" } },
                { type: "text", text: "You are an interactive agent...", cache_control: { type: "ephemeral" } },
            ],
            messages: [
                { role: "system", content: "extra instruction from the client" },
                { role: "user", content: "hi" },
            ],
        };

        const hoisted = hoistSystemMessages(body);
        const system = ensureSubscriptionSystemPrefix(hoisted.system) as Array<Record<string, unknown>>;

        expect(system[0]).toEqual({ type: "text", text: PREFIX, cache_control: { type: "ephemeral" } });
        expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
        expect(system.at(-1)).toEqual({ type: "text", text: "extra instruction from the client" });
        // The system-role entry must be gone from messages[] — leaving it there
        // is the 400 this hoist exists to prevent.
        expect((hoisted.messages as Array<Record<string, unknown>>).map((m) => m.role)).toEqual(["user"]);
    });

    it("still prepends the prefix when a foreign client sends only a system-role message", () => {
        const hoisted = hoistSystemMessages({
            messages: [
                { role: "system", content: "custom agent" },
                { role: "user", content: "hi" },
            ],
        });
        const system = ensureSubscriptionSystemPrefix(hoisted.system) as Array<Record<string, unknown>>;

        expect(system[0]).toEqual({ type: "text", text: PREFIX });
        expect(system[1]).toEqual({ type: "text", text: "custom agent" });
    });
});

describe("mergeBetas", () => {
    it("keeps the subscription betas and adds the client's", () => {
        // Without context-management-2025-06-27 the upstream answers 400
        // "context_management: Extra inputs are not permitted" on every Claude
        // Code turn, because Claude Code always sends that field.
        const merged = mergeBetas("oauth-2025-04-20,claude-code-20250219", "context-management-2025-06-27");

        expect(merged.split(",")).toEqual([
            "oauth-2025-04-20",
            "claude-code-20250219",
            "context-management-2025-06-27",
        ]);
    });

    it("dedupes and tolerates whitespace, empties and a missing client header", () => {
        expect(mergeBetas("a,b", " b , c ,, ")).toBe("a,b,c");
        expect(mergeBetas("a,b", null)).toBe("a,b");
        expect(mergeBetas("a,b", undefined)).toBe("a,b");
    });
});
