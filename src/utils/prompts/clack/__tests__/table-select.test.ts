import { describe, expect, test } from "bun:test";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";
import { buildFrameParts, renderFrame, type TableSelectOptions } from "../table-select";

const OPTS: TableSelectOptions<string> = {
    message: "Pick one",
    hint: "(hint)",
    columns: [
        { label: "NAME", minWidth: 6 },
        { label: "PCT", align: "right" },
    ],
    rows: [
        { value: "alpha", cells: ["alpha", pc.green("100%")], badge: pc.green("●") },
        { value: "beta", cells: ["beta", pc.red("5%")], detail: ["beta detail line"] },
    ],
};

describe("tableSelect renderFrame", () => {
    test("aligns columns and right-aligns numeric cells", () => {
        const parts = buildFrameParts(OPTS);
        const frame = stripAnsi(renderFrame(OPTS, parts, "active", 0));
        const lines = frame.split("\n");

        const header = lines.find((l) => l.includes("NAME"))!;
        const alphaRow = lines.find((l) => l.includes("alpha"))!;
        expect(header.indexOf("NAME")).toBe(alphaRow.indexOf("alpha"));
        // right-aligned PCT: "100%" and "5%" end at the same column
        const betaRow = lines.find((l) => l.includes("beta") && !l.includes("detail"))!;
        expect(alphaRow.indexOf("100%") + 4).toBe(betaRow.indexOf("5%") + 2);
        expect(frame).toContain("(hint)");
    });

    test("badge column reserved even for rows without a badge", () => {
        const parts = buildFrameParts(OPTS);
        const frame = stripAnsi(renderFrame(OPTS, parts, "active", 0));
        const lines = frame.split("\n");
        const alphaRow = lines.find((l) => l.includes("alpha"))!;
        const betaRow = lines.find((l) => l.includes("beta") && !l.includes("detail"))!;
        expect(alphaRow.indexOf("alpha")).toBe(betaRow.indexOf("beta"));
    });

    test("detail zone padded to shared fixed height across rows", () => {
        const parts = buildFrameParts(OPTS);
        const frame0 = stripAnsi(renderFrame(OPTS, parts, "active", 0));
        const frame1 = stripAnsi(renderFrame(OPTS, parts, "active", 1));
        expect(frame1).toContain("beta detail line");
        expect(frame0.split("\n").length).toBe(frame1.split("\n").length);
    });

    test("no detail zone when no row has detail", () => {
        const noDetail: TableSelectOptions<string> = {
            ...OPTS,
            rows: OPTS.rows.map((r) => ({ ...r, detail: undefined })),
        };
        const parts = buildFrameParts(noDetail);
        const frame = stripAnsi(renderFrame(noDetail, parts, "active", 0));
        expect(frame).not.toContain("┌");
    });

    test("focused first cell gets the accent color", () => {
        const parts = buildFrameParts(OPTS);
        const frame = renderFrame(OPTS, parts, "active", 0);
        expect(frame).toContain("\x1b[1;38;5;75malpha\x1b[22;39m");
    });

    test("submit and cancel frames collapse", () => {
        const parts = buildFrameParts(OPTS);
        expect(stripAnsi(renderFrame(OPTS, parts, "submit", 1))).toContain("beta");
        expect(stripAnsi(renderFrame(OPTS, parts, "cancel", 0))).toContain("cancelled");
        expect(stripAnsi(renderFrame(OPTS, parts, "submit", 1))).not.toContain("NAME");
    });
});
