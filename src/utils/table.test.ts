import { describe, it, expect } from "bun:test";
import { formatTable } from "./table";

describe("formatTable", () => {
    it("formats a basic table", () => {
        const result = formatTable([["Alice", "30"], ["Bob", "25"]], ["Name", "Age"]);
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
