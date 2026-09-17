/**
 * The two pure halves of the plan runner: what it refuses BEFORE acting, and
 * how it resolves a reference to an earlier step's result.
 *
 * Both exist because of measured failures (2026-09-09, handoff h_00ddcbx1):
 * a plan whose step 2 named `frobnicate` ran steps 1, 3, 4 and 5 anyway, having
 * already changed the app twice; and no step could consume an earlier step's
 * output, so "read a value, then type it" needed a human in the middle.
 *
 * No AX calls here on purpose — these must be checkable without a Mac in a
 * particular state, which is exactly what the old runner could not offer.
 */
import { describe, expect, test } from "bun:test";
import type { AxResult } from "../lib/runner";
import { resolveTemplates, validatePlan } from "./run";

const ok = (extra: Record<string, unknown> = {}): AxResult => ({ ok: true, ...extra }) as AxResult;

describe("validatePlan", () => {
    test("accepts a plan whose steps all name a known verb and have an app", () => {
        expect(validatePlan([{ do: "focus" }, { do: "press", q: "Save" }], "Genesis")).toEqual([]);
    });

    test("names an unknown verb with its step number, before anything runs", () => {
        const problems = validatePlan([{ do: "focus" }, { do: "frobnicate" }], "Genesis");

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("step 2");
        expect(problems[0]).toContain("frobnicate");
    });

    test("reports EVERY problem at once, not just the first", () => {
        expect(validatePlan([{ do: "frobnicate" }, {}, { do: "press", retries: -1 }], "Genesis")).toHaveLength(3);
    });

    test("a missing app is a problem only for steps that need one", () => {
        const problems = validatePlan([{ do: "snapshot" }, { do: "press", q: "Save" }], undefined);

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("step 2");
        expect(problems[0]).toContain("missing 'app'");
    });

    test("a per-step app satisfies it without a plan default", () => {
        expect(validatePlan([{ do: "press", q: "Save", app: "Genesis" }], undefined)).toEqual([]);
    });

    test("the native read verbs that were missing from the plan schema are accepted now", () => {
        const visual = ["dump", "typography", "hittest"].map((verb) => ({ do: verb }));

        expect(validatePlan(visual, "Genesis")).toEqual([]);
    });

    test("draw and compare-screenshot are REFUSED: native ax-tool has no such subcommand", () => {
        // Accepting them would be a promise the runner cannot keep — every such
        // step reaches ax-tool's `default: errorExit("unknown command")`.
        for (const verb of ["draw", "compare-screenshot"]) {
            expect(validatePlan([{ do: verb }], "Genesis")[0]).toContain(`unknown step command '${verb}'`);
        }
    });

    test("hittest needs no app, so it is valid with no plan default", () => {
        expect(validatePlan([{ do: "hittest", at: "10,10" }], undefined)).toEqual([]);
    });

    describe("retries", () => {
        test("refused on a mutating step, because a retry would act twice", () => {
            const problems = validatePlan([{ do: "type", text: "x", retries: 2 }], "Genesis");

            expect(problems[0]).toContain("not allowed on a mutating step");
        });

        test("allowed on a read step", () => {
            expect(validatePlan([{ do: "get", q: "Save", retries: 2 }], "Genesis")).toEqual([]);
        });

        test("Infinity is refused — comment-json turns 1e309 into it and the loop never ends", () => {
            expect(validatePlan([{ do: "get", retries: Number.POSITIVE_INFINITY }], "Genesis")[0]).toContain(
                "whole number"
            );
        });

        test.each([
            ["fractional", 1.5],
            ["negative", -1],
            ["beyond the ceiling", 999],
        ])("%s is refused", (_label, retries) => {
            expect(validatePlan([{ do: "get", retries }], "Genesis")[0]).toContain("whole number");
        });

        test("an unbounded retryDelayMs is refused, since Bun.sleep would clamp it to days", () => {
            expect(validatePlan([{ do: "get", retries: 1, retryDelayMs: 9e12 }], "Genesis")[0]).toContain(
                "retryDelayMs"
            );
        });
    });

    test.each([
        ["null", null],
        ["an array", []],
        ["a string", "focus"],
    ])("a step that is %s is reported, not thrown on", (_label, step) => {
        expect(validatePlan([step as never], "Genesis")[0]).toContain("must be an object");
    });

    test("an action alias is resolved before the verb is judged", () => {
        expect(validatePlan([{ do: "ax-press", q: "Save" }], "Genesis")).toEqual([]);
    });

    test("retries and saveAs are type-checked", () => {
        expect(validatePlan([{ do: "press", retries: "two" }], "Genesis")[0]).toContain("'retries'");
        expect(validatePlan([{ do: "press", saveAs: 3 }], "Genesis")[0]).toContain("'saveAs'");
    });
});

describe("resolveTemplates", () => {
    const results = [{ result: ok({ value: "first" }) }, { result: ok({ value: "second", count: 7 }) }];
    const saved = new Map<string, AxResult>([["total", ok({ value: "42" })]]);

    test("reads a field out of an earlier step's result by index", () => {
        expect(resolveTemplates("{{steps.1.result.value}}", results, saved)).toEqual({
            text: "second",
            unresolved: [],
        });
    });

    test("reads a named step through saveAs", () => {
        expect(resolveTemplates("total is {{saved.total.value}}", results, saved).text).toBe("total is 42");
    });

    test("substitutes several references in one string", () => {
        expect(resolveTemplates("{{steps.0.result.value}}/{{steps.1.result.count}}", results, saved).text).toBe(
            "first/7"
        );
    });

    test("leaves an unknown reference VERBATIM and reports it, rather than emptying it", () => {
        const resolved = resolveTemplates("{{steps.9.result.value}}", results, saved);

        // Substituting "" would send `--value ""` and read as a successful write
        // of nothing; the runner turns a reported unresolved reference into a
        // refusal instead.
        expect(resolved.text).toBe("{{steps.9.result.value}}");
        expect(resolved.unresolved).toEqual(["{{steps.9.result.value}}"]);
    });

    test("an unknown root is reported, not guessed at", () => {
        expect(resolveTemplates("{{env.HOME}}", results, saved).unresolved).toEqual(["{{env.HOME}}"]);
    });

    test("a reference landing on an object is unresolved, never '[object Object]'", () => {
        const nested = [{ result: ok({ window: { id: 3 } }) }];

        expect(resolveTemplates("{{steps.0.result.window}}", nested, saved).unresolved).toHaveLength(1);
        expect(resolveTemplates("{{steps.0.result.window.id}}", nested, saved).text).toBe("3");
    });

    test("text with no reference is returned untouched", () => {
        expect(resolveTemplates("plain text", results, saved)).toEqual({ text: "plain text", unresolved: [] });
    });
});
