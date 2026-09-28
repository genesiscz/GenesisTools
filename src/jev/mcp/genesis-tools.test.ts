import { describe, expect, test } from "bun:test";
import { type Evaluator, lazyEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { GrepSetupError } from "../lib/grep/search";
import { jevToolEntries } from "./genesis-tools";
import { lazyGrepEvaluator } from "./tools/grep";

describe("lazy evaluators", () => {
    const evaluator: Evaluator = async () => {
        throw new Error("not called here");
    };
    const failingOnce = () => {
        let attempts = 0;
        return {
            create: async () => {
                attempts++;
                if (attempts === 1) {
                    throw new Error("No Jev key; run tools jev login.");
                }

                return evaluator;
            },
            get attempts() {
                return attempts;
            },
        };
    };

    test("a failed creation is not kept, a successful one is", async () => {
        const source = failingOnce();
        const shared = lazyEvaluator(source.create);
        await expect(shared()).rejects.toThrow("No Jev key");
        expect(await shared()).toBe(evaluator);
        expect(await shared()).toBe(evaluator);
        expect(source.attempts).toBe(2);
    });

    test("jev_grep reports a missing key as a credential error and picks up a later login", async () => {
        const source = failingOnce();
        const grep = lazyGrepEvaluator({ provider: "typesafe" }, source.create);
        const failure = await grep().catch((error: unknown) => error);
        expect(failure instanceof GrepSetupError && failure.kind).toBe("credentials");
        expect(await grep()).toBe(evaluator);
    });
});

describe("jevToolEntries", () => {
    test("exposes every Jev MCP tool under the jev_ prefix with a JSON schema", () => {
        const entries = jevToolEntries();
        expect(Object.keys(entries).sort()).toEqual([
            "jev_compact",
            "jev_grep",
            "jev_route",
            "jev_verify",
            "jev_verify_templates",
        ]);
        for (const [name, entry] of Object.entries(entries)) {
            expect(name.startsWith("jev_")).toBe(true);
            expect(entry.description.length).toBeGreaterThan(0);
            expect(entry.inputSchema.type).toBe("object");
        }
    });

    test("the handler returns JSON text the host can parse back", async () => {
        const entries = jevToolEntries();
        const text = await entries.jev_verify_templates.handler({}, { signal: new AbortController().signal });
        const parsed: { templates?: unknown[] } = SafeJSON.parse(text);
        expect(Array.isArray(parsed.templates)).toBe(true);
    });
});
