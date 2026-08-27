import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
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
     * Colour is turned off through a child process with NO_COLOR=1, which is the only
     * deterministic way to reach that state: picocolors decides once at import time, and
     * "bun test means no TTY means no colour" is FALSE on CI — picocolors also enables
     * colour whenever $CI is set, so this assertion used to pass locally and fail on
     * every GitHub Actions run. Any escape sequence surviving NO_COLOR came from
     * something that consults neither it nor the TTY check.
     */
    it("emits no escape sequences when the output is not a terminal", () => {
        const script =
            `const { createBoxTable } = await import(${SafeJSON.stringify(join(import.meta.dir, "table.ts"))});\n` +
            `const table = createBoxTable(["NAME", "STATUS"]);\n` +
            `table.push(["alice", "ok"]);\n` +
            `process.stdout.write(table.toString());\n`;

        const proc = Bun.spawnSync(["bun", "-e", script], {
            env: { ...process.env, NO_COLOR: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const rendered = proc.stdout.toString();

        expect(proc.stderr.toString()).toBe("");
        expect(proc.exitCode).toBe(0);
        // The negative control for the subprocess itself: an empty stdout would pass the
        // escape-sequence assertion without having rendered anything.
        expect(rendered).toContain("alice");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
        expect(rendered).not.toMatch(/\x1b\[/);
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
