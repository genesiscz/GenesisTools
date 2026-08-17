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

    /**
     * Borders must be coloured through picocolors, never through cli-table3's `style.border`.
     * That option paints with its own colour library, which consults neither the TTY check nor
     * NO_COLOR, so `tools spotify doctor > report.txt` wrote escape sequences into the file
     * while every other command in the same tool redirected cleanly.
     *
     * These tests run under bun test, where stdout is not a TTY, so picocolors is already
     * disabled: any escape sequence surviving here came from something that ignores it.
     */
    it("emits no escape sequences when the output is not a terminal", () => {
        const table = createBoxTable(["NAME", "STATUS"]);
        table.push(["alice", "ok"]);

        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
        expect(table.toString()).not.toMatch(/\x1b\[/);
    });

    // The negative control: the borders must still be THERE, just uncoloured. A fix that
    // dropped the box characters would also pass the assertion above.
    it("still draws its borders when colour is off", () => {
        // Two columns and a row, so every character in the set is actually reachable: the
        // column joins (┬ ┼ ┴) only appear once there is more than one column.
        const table = createBoxTable(["NAME", "STATUS"]);
        table.push(["alice", "ok"]);
        const drawn = new Set(table.toString().match(/[─│┌┐└┘├┤┬┴┼]/g) ?? []);

        expect([...drawn].sort().join("")).toBe([..."─│┌┐└┘├┤┬┴┼"].sort().join(""));
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
