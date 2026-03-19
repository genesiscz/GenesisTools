import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { runTool, stripAnsi } from "./helpers";

describe("tools macos mail", () => {
    describe("help", () => {
        it("--help exits 0", async () => {
            const r = await runTool(["macos", "mail", "--help"]);
            expect(r.exitCode).toBe(0);
        });

        it("list --help exits 0 and mentions --columns, --format, --limit", async () => {
            const r = await runTool(["macos", "mail", "list", "--help"]);
            expect(r.exitCode).toBe(0);
            const out = stripAnsi(r.stdout);

            expect(out).toContain("--columns");
            expect(out).toContain("--format");
            expect(out).toContain("--limit");
        });

        it("search --help exits 0 and mentions --columns, --format", async () => {
            const r = await runTool(["macos", "mail", "search", "--help"]);
            expect(r.exitCode).toBe(0);
            const out = stripAnsi(r.stdout);

            expect(out).toContain("--columns");
            expect(out).toContain("--format");
        });
    });

    describe("list --help column names", () => {
        const ALL_COLUMNS = [
            "date",
            "from",
            "fromEmail",
            "to",
            "toEmail",
            "cc",
            "subject",
            "mailbox",
            "account",
            "read",
            "flagged",
            "size",
            "attachments",
        ];

        it("list --help output contains all column names", async () => {
            const r = await runTool(["macos", "mail", "list", "--help"]);
            const out = stripAnsi(r.stdout);

            for (const col of ALL_COLUMNS) {
                expect(out).toContain(col);
            }
        });
    });

    describe("invalid column", () => {
        it("list --columns invalid_col should warn about unknown column", async () => {
            const r = await runTool(["macos", "mail", "list", "--columns", "invalid_col"]);
            const combined = stripAnsi(r.stdout + r.stderr);
            expect(combined).toContain("Unknown column");
        });
    });

    describe("monitor", () => {
        it("monitor --help exits 0 and mentions --limit, --notify-telegram, --dry-run", async () => {
            const r = await runTool(["macos", "mail", "monitor", "--help"]);
            expect(r.exitCode).toBe(0);
            const out = stripAnsi(r.stdout);

            expect(out).toContain("--limit");
            expect(out).toContain("--notify-telegram");
            expect(out).toContain("--dry-run");
        });
    });

    describe("format flag", () => {
        it("list --format json --limit 1 accepts the format flag", async () => {
            const r = await runTool(["macos", "mail", "list", "--format", "json", "--limit", "1"], 30_000);

            // If mail DB is accessible, we get valid JSON output.
            // If not (e.g. no Full Disk Access), we still verify the flags are accepted
            // by checking it doesn't fail with "unknown option".
            const combined = stripAnsi(r.stdout + r.stderr);
            expect(combined).not.toContain("unknown option");

            if (r.exitCode === 0 && r.stdout.trim().length > 0) {
                // The output contains clack spinner control sequences mixed with JSON.
                // Find the line that starts with '[' and collect until the matching ']'.
                const lines = r.stdout.split("\n");
                const startIdx = lines.findIndex((l) => l.trim() === "[");
                const endIdx = lines.findLastIndex((l) => l.trim() === "]");

                if (startIdx !== -1 && endIdx > startIdx) {
                    const jsonStr = lines.slice(startIdx, endIdx + 1).join("\n");
                    const parsed = SafeJSON.parse(jsonStr);
                    expect(Array.isArray(parsed)).toBe(true);
                }
            }
        }, 30_000);
    });
});
