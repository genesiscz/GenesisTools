import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDocumentCommands } from "@app/json2md/commands/document";
import { out } from "@genesiscz/utils/logger";
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

// Regression test: PR #456 review — the link check only searched the document's own source, so a
// document that reaches the package through a local helper was imported without it and failed in
// Bun's resolver (or its auto-installer) instead of printing the link guidance
describe("json2md build link check", () => {
    test("a package import reached through a local helper still gets the link guidance", async () => {
        const dir = mkdtempSync(join(tmpdir(), "json2md-transitive-"));
        await Bun.write(
            join(dir, "helper.ts"),
            'export { defineDocument } from "@genesiscz/utils/json2md/document-file";\n'
        );
        await Bun.write(
            join(dir, "doc.ts"),
            'import { defineDocument } from "./helper";\n\nexport default defineDocument({ data: "./doc.json", render: () => [] });\n'
        );
        const errors = spyOn(out.log, "error").mockImplementation(() => undefined);
        const infos = spyOn(out.log, "info").mockImplementation(() => undefined);
        const program = new Command();
        registerDocumentCommands(program);
        const originalExitCode = process.exitCode;

        try {
            await program.parseAsync(["node", "json2md", "build", join(dir, "doc.ts")], { from: "node" });

            expect(process.exitCode).toBe(1);
            expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toContain("does not resolve from");
        } finally {
            errors.mockRestore();
            infos.mockRestore();
            process.exitCode = originalExitCode;
        }
    });
});

describe("json2md entry point errors", () => {
    // Regression test: #452 — a failing `json2md build` printed "ERROR: Error: <message>":
    // the entry point's catch added its own "Error: " after the logger's ERROR label.
    test("a build failure is reported without a second 'Error:' prefix", async () => {
        const dir = mkdtempSync(join(tmpdir(), "json2md-build-error-"));
        const modulePath = join(dir, "broken.ts");
        await Bun.write(modulePath, 'throw new Error("broken document module");\n');

        const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "index.ts"), "build", modulePath], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, NO_COLOR: "1" },
        });
        const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

        expect(exitCode).toBe(1);
        expect(stderr).toContain("broken document module");
        expect(stderr).not.toContain("Error: broken document module");
    });
});

/**
 * Runs `argv` under a real pseudo-terminal, python's stdlib `pty` module.
 *
 * Bun's bare-specifier resolver falls through to its auto-installer whenever the specifier is
 * not found locally, and the installer renders its "Resolving […]" progress through the
 * process's own TTY. A piped, non-TTY capture never shows it — confirmed empirically: the exact
 * same command, piped, never prints it, pty-backed, always does when the bug is present — so a
 * test that pipes stdio instead of allocating a pty cannot fail even with the bug still in
 * place, and would prove nothing. `pty` is CPython stdlib on every platform this suite runs on
 * (macOS and the ubuntu CI runner), so this needs no native test dependency.
 */
async function runUnderPty(argv: string[], env: Record<string, string>): Promise<{ output: string; exitCode: number }> {
    const script = `
import os, pty, sys

pid, fd = pty.fork()

if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

chunks = []

while True:
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break

    if not chunk:
        break

    chunks.append(chunk)

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(b"".join(chunks))
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`;

    const proc = Bun.spawn(["python3", "-c", script, ...argv], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
    });
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    return { output, exitCode };
}

describe("json2md init/build never trigger Bun's auto-installer", () => {
    // Regression test: #452 item 3b — on a real terminal, `init`'s resolve check and `build`'s
    // import of the user's module both let a bare `@genesiscz/utils` specifier fall through to
    // Bun's auto-installer. The installer attempts a live npm lookup for a package that was
    // never published, and prints a progress line with no trailing newline before giving up, so
    // the next thing printed glues onto it. A "does it resolve?" check must never download
    // anything either way — this is a supply-chain risk, not just a cosmetic one.
    test("link guidance replaces the download attempt, for both init and build", async () => {
        const dir = mkdtempSync(join(tmpdir(), "json2md-no-autoinstall-"));
        const indexPath = join(import.meta.dir, "..", "index.ts");
        const modulePath = join(dir, "demo-doc.ts");

        const init = await runUnderPty(["bun", "run", indexPath, "init", join(dir, "demo-doc")], { NO_COLOR: "1" });

        expect(init.exitCode).toBe(0);
        expect(init.output).not.toContain("Resolving [");
        expect(init.output).toContain("does not resolve from");
        expect(init.output).toContain("tools link install");

        const build = await runUnderPty(["bun", "run", indexPath, "build", modulePath], { NO_COLOR: "1" });

        expect(build.exitCode).toBe(1);
        expect(build.output).not.toContain("Resolving [");
        expect(build.output).toContain("does not resolve from");
    });
});
