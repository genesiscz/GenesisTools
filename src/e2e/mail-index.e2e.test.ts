import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runTool, stripAnsi } from "@app/utils/e2e/helpers";

const isDarwin = process.platform === "darwin";
const ENVELOPE_INDEX = join(homedir(), "Library/Mail/V10/MailData/Envelope Index");
const hasMailData = isDarwin && existsSync(ENVELOPE_INDEX);

describe.skipIf(!isDarwin)("tools macos mail index", () => {
    it(
        "shows help with --help",
        async () => {
            const result = await runTool(["macos", "mail", "index", "--help"]);
            const output = stripAnsi(result.stdout + result.stderr);
            expect(output).toContain("Build/update a searchable index");
            expect(output).toContain("--model");
            expect(output).toContain("--rebuild");
            expect(output).toContain("--no-embed");
        },
        { timeout: 15_000 }
    );
});

describe.skipIf(!isDarwin)("tools macos mail search", () => {
    it(
        "shows help with --help",
        async () => {
            const result = await runTool(["macos", "mail", "search", "--help"]);
            const output = stripAnsi(result.stdout + result.stderr);
            expect(output).toContain("Search emails");
            expect(output).toContain("--dumb");
        },
        { timeout: 15_000 }
    );

    it.skipIf(!hasMailData)(
        "searches with --dumb flag (legacy search)",
        async () => {
            const result = await runTool(
                ["macos", "mail", "search", "test", "--dumb", "--without-body", "--no-semantic", "--limit", "5"],
                30_000
            );
            // Should not error
            expect(result.exitCode).toBe(0);
        },
        { timeout: 45_000 }
    );
});
