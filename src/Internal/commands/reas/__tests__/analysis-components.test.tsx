import { describe, expect, test } from "bun:test";
import {
    getScoreGaugeDisplay,
    INFO_BOX_TONE_STYLES,
    STAT_CARD_ACCENT_STYLES,
    sortDataTableRows,
} from "@app/Internal/commands/reas/ui/src/components/analysis/shared";

interface TableRowModel {
    name: string;
    score: number;
    link: string;
}

describe("analysis shared components", () => {
    test("shared accent styles expose the intended border classes", () => {
        expect(STAT_CARD_ACCENT_STYLES.cyan).toBe("border-l-cyan-400");
        expect(INFO_BOX_TONE_STYLES.warning).toContain("border-amber-500/30");
    });

    test("score gauge display clamps score to max", () => {
        expect(getScoreGaugeDisplay({ score: 112, max: 100 })).toEqual({
            safeMax: 100,
            clampedScore: 100,
            angle: 360,
        });
    });

    test("table sorting returns rows in descending order", () => {
        const sorted = sortDataTableRows<TableRowModel>({
            rows: [
                { name: "Beta", score: 55, link: "https://example.com/beta" },
                { name: "Alpha", score: 72, link: "https://example.com/alpha" },
            ],
            direction: "desc",
            getValue: (row) => row.score,
        });

        expect(sorted.map((row) => row.name)).toEqual(["Alpha", "Beta"]);
    });
});
