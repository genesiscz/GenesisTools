/**
 * Makes an invented screen recording folder, so the recording editor can be opened and screenshotted without any real
 * screen content (the writer, `recording-sandbox-writer.ts`, says what it draws).
 *
 *     bun scripts/fixtures/recording-sandbox.ts --out <dir>
 *
 * This launcher imports nothing that opens the logger: it runs the writer with `GENESIS_TOOLS_HOME` set to a temporary
 * home (or to the one already set), so the day log file and every other `~/.genesis-tools` path stay off the real one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";

const WRITER = join(moduleDir(import.meta), "recording-sandbox-writer.ts");

async function runWriter(home: string): Promise<number> {
    const proc = Bun.spawn([process.execPath, WRITER, ...process.argv.slice(2)], {
        env: { ...process.env, GENESIS_TOOLS_HOME: home },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    return proc.exited;
}

if (import.meta.main) {
    if (env.tools.hasExplicitHome()) {
        process.exitCode = await runWriter(env.tools.getHome());
    } else {
        const home = mkdtempSync(join(tmpdir(), "recording-sandbox-home-"));

        try {
            process.exitCode = await runWriter(home);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }
}
