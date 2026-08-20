import { describe, expect, it } from "bun:test";
import { clampXaiReasoningEffort, mapOpenRouterReasoningEffort } from "@app/ai-proxy/lib/reasoning-effort-vocab";
import { SafeJSON } from "@genesiscz/utils/json";

function effortOf(bodyText: string): unknown {
    const parsed = SafeJSON.parse(bodyText, { strict: true }) as Record<string, unknown>;
    return parsed.reasoning_effort;
}

describe("clampXaiReasoningEffort", () => {
    it("keeps xhigh on grok-4.6 and maps the proxy-only values onto xAI's ladder", () => {
        const body = '{"reasoning_effort":"xhigh"}';
        expect(clampXaiReasoningEffort(body, "grok-4.6")).toBe(body);

        expect(effortOf(clampXaiReasoningEffort('{"reasoning_effort":"max"}', "grok-4.6"))).toBe("xhigh");
        expect(effortOf(clampXaiReasoningEffort('{"reasoning_effort":"minimal"}', "grok-4.6"))).toBe("low");
    });

    it("clamps down to what grok-4.5 accepts", () => {
        expect(effortOf(clampXaiReasoningEffort('{"reasoning_effort":"xhigh"}', "grok-4.5"))).toBe("high");
        expect(effortOf(clampXaiReasoningEffort('{"reasoning_effort":"max"}', "grok-4.5"))).toBe("high");
        expect(clampXaiReasoningEffort('{"reasoning_effort":"medium"}', "grok-4.5")).toBe(
            '{"reasoning_effort":"medium"}'
        );
    });

    it("clamps to grok-3-mini's low|high pair, rounding an in-between ask up", () => {
        expect(effortOf(clampXaiReasoningEffort('{"reasoning_effort":"medium"}', "grok-3-mini"))).toBe("high");
        expect(effortOf(clampXaiReasoningEffort('{"reasoning_effort":"minimal"}', "grok-3-mini"))).toBe("low");
    });

    it("strips the field entirely for models that reject the parameter", () => {
        // xAI answers HTTP 400 "does not support parameter reasoningEffort" on
        // these families — a dropped stamp beats a dead request.
        for (const model of ["grok-4-fast", "grok-code-fast-1", "grok-4-1-fast", "grok-3"]) {
            const out = SafeJSON.parse(clampXaiReasoningEffort('{"reasoning_effort":"high","messages":[]}', model), {
                strict: true,
            }) as Record<string, unknown>;

            expect("reasoning_effort" in out).toBe(false);
            expect(out.messages).toEqual([]);
        }
    });

    it("strips the nested reasoning.effort the Responses door stamps, too", () => {
        const out = SafeJSON.parse(
            clampXaiReasoningEffort('{"reasoning":{"effort":"xhigh","summary":"auto"}}', "grok-4-fast"),
            {
                strict: true,
            }
        ) as { reasoning: Record<string, unknown> };

        expect("effort" in out.reasoning).toBe(false);
        expect(out.reasoning.summary).toBe("auto");
    });

    it("forwards a non-proxy value verbatim on an effort-taking family, so a wrong client value fails loudly", () => {
        const body = '{"reasoning_effort":"banana"}';
        expect(clampXaiReasoningEffort(body, "grok-4.6")).toBe(body);
    });

    it("returns unparseable bodies untouched", () => {
        expect(clampXaiReasoningEffort("not json", "grok-4.6")).toBe("not json");
    });
});

describe("mapOpenRouterReasoningEffort", () => {
    it("maps only the top-level max to xhigh", () => {
        expect(effortOf(mapOpenRouterReasoningEffort('{"reasoning_effort":"max"}'))).toBe("xhigh");

        // Everything else in the proxy vocabulary is in OpenRouter's enum.
        for (const value of ["minimal", "low", "medium", "high", "xhigh"]) {
            const body = `{"reasoning_effort":"${value}"}`;
            expect(mapOpenRouterReasoningEffort(body)).toBe(body);
        }
    });

    it("returns unparseable bodies untouched", () => {
        expect(mapOpenRouterReasoningEffort("not json")).toBe("not json");
    });
});
