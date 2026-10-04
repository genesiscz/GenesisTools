import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDocumentCommands } from "@app/json2md/commands/document";
import { Command } from "commander";

/**
 * Regression test: #452 — `json2md init` exited 1 after successfully creating the sample
 * `.json` and `.ts` files, whenever the folder was not yet linked to `@genesiscz/utils`. The
 * files ARE created; not being linked yet is guidance (what to run next), not a failure.
 *
 * `mkdtempSync(tmpdir())` is deliberately outside the home directory, so no ancestor
 * `tsconfig.json` can map the package here — the same "package does not resolve yet" shape
 * the report reproduced in a scratch workspace.
 */
describe("json2md init", () => {
    test("exits 0 after creating the scaffold files, even when the folder is not linked", async () => {
        const dir = mkdtempSync(join(tmpdir(), "json2md-init-"));
        const program = new Command();
        registerDocumentCommands(program);

        const originalExitCode = process.exitCode;
        process.exitCode = undefined;

        try {
            await program.parseAsync(["node", "json2md", "init", join(dir, "demo-doc")], { from: "node" });

            expect(process.exitCode ?? 0).toBe(0);
            expect(await Bun.file(join(dir, "demo-doc.json")).exists()).toBe(true);
            expect(await Bun.file(join(dir, "demo-doc.ts")).exists()).toBe(true);
        } finally {
            process.exitCode = originalExitCode;
        }
    });
});
