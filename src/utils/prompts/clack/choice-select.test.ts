import { describe, expect, test } from "bun:test";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";
import {
    CHOICE_FOOTER,
    type ChoiceRow,
    type ChoiceSelectOptions,
    choiceChip,
    heardMark,
    renderChoiceFrame,
} from "./choice-select";

const rows: ChoiceRow<string>[] = [
    { value: "martin", label: "Martin", kind: "answer" },
    { value: "petr", label: "Petr Novák", kind: "answer", hint: "as at 1:01" },
    {
        value: "again",
        label: "Play the audio again",
        hint: "from the start",
        kind: "action",
        glyph: "↻",
        paint: pc.yellow,
    },
    { value: "skip", label: "Skip", kind: "action", glyph: "»", paint: pc.dim },
];

function options(overrides: Partial<ChoiceSelectOptions<string>> = {}): ChoiceSelectOptions<string> {
    return {
        message: 'Is "Yenkins" at 2:14 really "Jenkins"?',
        header: `${choiceChip("Q9")} ${pc.dim("4/8 · 2:14–2:16")}`,
        context: [pc.dim("Before."), `Ale build na ${heardMark("Yenkins")} spadl.`, pc.dim("After.")],
        note: pc.dim("you answered these words at 1:01"),
        rows,
        footer: CHOICE_FOOTER,
        ...overrides,
    };
}

const frame = (opts: ChoiceSelectOptions<string>, state: string, cursor: number, columns = 80, height = 40) =>
    stripAnsi(renderChoiceFrame(opts, state, cursor, { columns, rows: height })).split("\n");

describe("renderChoiceFrame", () => {
    test("every focused row stays visible in a short terminal", () => {
        const many: ChoiceRow<string>[] = Array.from({ length: 20 }, (_, i) => ({
            value: String(i),
            label: `Choice ${i} end`,
            kind: i < 15 ? "answer" : "action",
        }));
        for (let cursor = 0; cursor < many.length; cursor += 1) {
            const lines = frame(options({ rows: many }), "active", cursor, 80, 7);
            expect(lines.join("\n")).toContain(`Choice ${cursor} end`);
            expect(lines.some((line) => line.includes("❯") && line.includes(`Choice ${cursor} end`))).toBe(true);
            expect(lines.length).toBeLessThanOrEqual(6);
        }
    });

    test("answers and actions sit under their own headings, the hint of the focused row on its own line", () => {
        const lines = frame(options(), "active", 2);
        const text = lines.join("\n");
        expect(text).toContain("── answers");
        expect(text).toContain("── actions");
        expect(lines.findIndex((l) => l.includes("── answers"))).toBeLessThan(
            lines.findIndex((l) => l.includes("Martin"))
        );
        expect(lines.findIndex((l) => l.includes("Martin"))).toBeLessThan(
            lines.findIndex((l) => l.includes("── actions"))
        );
        expect(lines.some((l) => l.includes("❯ ↻ Play the audio again"))).toBe(true);
        expect(lines.some((l) => l.trim() === "│  ↳ from the start")).toBe(true);
    });

    test("no line is wider than the screen and the frame is never taller than it", () => {
        const long = options({
            message: `Who says "${"word ".repeat(40)}"?`,
            context: [`${"x ".repeat(120)}${heardMark("hit")}`],
        });

        for (const [columns, height] of [
            [40, 30],
            [80, 12],
            [30, 8],
        ] as const) {
            const lines = frame(long, "active", 0, columns, height);
            expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThanOrEqual(columns - 1);
            expect(lines.length).toBeLessThanOrEqual(height - 1);
        }
    });

    test("a short screen drops the context first, never the rows", () => {
        const lines = frame(options(), "active", 0, 80, 14).join("\n");
        expect(lines).not.toContain("Before.");
        expect(lines).toContain("Martin");
        expect(lines).toContain("Skip");
    });

    test("the answered state is three lines: rule, question, answer", () => {
        const lines = frame(options(), "submit", 1);
        expect(lines).toHaveLength(3);
        expect(lines[2]).toContain("✓ Petr Novák");
    });

    test("the cancelled state says so", () => {
        expect(frame(options(), "cancel", 0).join("\n")).toContain("cancelled");
    });
});
