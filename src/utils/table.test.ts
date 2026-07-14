import { describe, expect, it } from "bun:test";
import { createBoxTable, formatDotStatus, formatTable, truncateDisplay } from "./table";

describe("formatTable", () => {
    it("formats a basic table", () => {
        const result = formatTable(
            [
                ["Alice", "30"],
                ["Bob", "25"],
            ],
            ["Name", "Age"]
        );
        const lines = result.split("\n");
        expect(lines.length).toBe(4);
        expect(lines[0]).toContain("Name");
        expect(lines[0]).toContain("Age");
        expect(lines[1]).toContain("─");
        expect(lines[2]).toContain("Alice");
        expect(lines[3]).toContain("Bob");
    });

    it("right-aligns specified columns", () => {
        const result = formatTable([["Alice", "30"]], ["Name", "Age"], { alignRight: [1] });
        const lines = result.split("\n");
        const dataParts = lines[2].split("  ");
        expect(dataParts[1].trimStart()).toBe("30");
    });

    it("truncates cells exceeding maxColWidth", () => {
        const longValue = "a".repeat(60);
        const result = formatTable([[longValue]], ["Header"], { maxColWidth: 20 });
        const lines = result.split("\n");
        expect(lines[2].trim().length).toBeLessThanOrEqual(20);
        expect(lines[2]).toContain("...");
    });

    it("handles empty rows", () => {
        const result = formatTable([], ["Name", "Age"]);
        const lines = result.split("\n");
        expect(lines.length).toBe(2);
    });
});

describe("createBoxTable", () => {
    it("renders a boxed table with headers and rows", () => {
        const table = createBoxTable(["NAME", "STATUS"]);
        table.push(["alice", "ok"]);
        const text = table.toString();
        expect(text).toContain("NAME");
        expect(text).toContain("STATUS");
        expect(text).toContain("alice");
        expect(text).toContain("┌");
        expect(text).toContain("│");
    });
});

describe("truncateDisplay", () => {
    it("returns em dash for empty values", () => {
        expect(truncateDisplay(null, 10)).toBe("—");
        expect(truncateDisplay(undefined, 10)).toBe("—");
        expect(truncateDisplay("", 10)).toBe("—");
    });

    it("truncates with single-char ellipsis", () => {
        expect(truncateDisplay("abcdefghij", 5)).toBe("abcd…");
        expect(truncateDisplay("short", 10)).toBe("short");
    });
});

describe("formatDotStatus", () => {
    it("includes the bullet and label", () => {
        expect(formatDotStatus("ok", "yes")).toContain("●");
        expect(formatDotStatus("ok", "yes")).toContain("yes");
        expect(formatDotStatus("err", "fail")).toContain("fail");
    });
});
