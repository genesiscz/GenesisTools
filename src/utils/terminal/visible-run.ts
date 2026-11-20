import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { detectTerminalApp } from "@genesiscz/utils/terminal";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";

/** A `.command` file this old was never started by a terminal (its script deletes itself first), so it goes. */
export const STALE_COMMAND_FILE_MS = 60 * 60 * 1000;

/**
 * The `.command` script: it deletes itself before it runs the command, so the argv (which may hold a secret) stays on
 * disk only until the terminal starts it. The shell keeps reading the open file after the unlink. It echoes only the
 * program's name, never its arguments, so a secret never reaches the terminal's scrollback or its log.
 */
export function visibleCommandScript(argv: readonly string[]): string {
    const command = shellCommandLine(argv);
    const label = `Running ${basename(argv[0] ?? "the command")} (arguments not shown)`;
    return `#!/bin/sh\nrm -f -- "$0"\nprintf '%s\\n' ${shellCommandLine([label])}\n${command}\nresult=$?\nif [ "$result" -ne 0 ]; then\n  printf 'Command failed (%s). Press Return to close.\\n' "$result"\n  read -r answer\nelse\n  sleep 5\nfi\nexit "$result"\n`;
}

function removeCommandFile(file: string): void {
    try {
        unlinkSync(file);
    } catch (error) {
        logger.debug({ error, file }, "visible run: the command file was already gone");
    }
}

/**
 * Deletes the `.command` files in `dir` that no terminal started within {@link STALE_COMMAND_FILE_MS}. A file that
 * goes between the listing and its stat (its terminal started it, and it deleted itself) is skipped.
 */
export function removeStaleCommandFiles(dir: string, now: number = Date.now()): string[] {
    const removed: string[] = [];

    for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const stat = name.endsWith(".command") ? statSync(file, { throwIfNoEntry: false }) : undefined;

        if (stat && now - stat.mtimeMs > STALE_COMMAND_FILE_MS) {
            removeCommandFile(file);
            removed.push(file);
        }
    }

    return removed;
}

/**
 * cmux gets its own workspace; otherwise Launch Services opens a .command file in the person's terminal. `signal` is
 * the caller's deadline or cancel: no step starts after it aborts, and it is read again right before the command is
 * typed or the file is opened, so a caller that already returned never has the command run late (and twice on a retry).
 */
export async function runVisibly(options: {
    argv: readonly string[];
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<{ opened: true }> {
    refuseHostEffectInTest("visible terminal", "Inject a terminal runner in tests.");
    options.signal?.throwIfAborted();
    if (process.platform !== "darwin") {
        throw new Error("Visible terminal execution is currently available on macOS.");
    }
    if (detectTerminalApp() === "cmux") {
        const [{ identifyCmux }, { openCommandAt }] = await Promise.all([
            import("@genesiscz/utils/cmux/lib/place"),
            import("@genesiscz/utils/cmux/open-command"),
        ]);
        const place = await identifyCmux({ timeoutMs: Math.min(options.timeoutMs, 2000) });
        const windowId = place.caller.windowId ?? place.focused.windowId;
        if (windowId) {
            await openCommandAt({
                command: shellCommandLine(options.argv),
                target: { kind: "window", windowId },
                title: "GenesisTools action",
                workspaceName: "GenesisTools action",
                signal: options.signal,
            });
            return { opened: true };
        }
    }
    options.signal?.throwIfAborted();
    const dir = toolDataDir("genesis-tools", "terminal");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Clean-up is best effort: an old file that cannot be inspected must not stop this run.
    try {
        removeStaleCommandFiles(dir);
    } catch (error) {
        logger.warn({ error, dir }, "visible run: could not clean up old command files");
    }

    const file = join(dir, `${crypto.randomUUID()}.command`);
    writeFileSync(file, visibleCommandScript(options.argv), { mode: 0o700 });
    const proc = Bun.spawn(["/usr/bin/open", file], {
        stdout: "ignore",
        stderr: "pipe",
        timeout: Math.min(options.timeoutMs, 15_000),
    });
    const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exit !== 0) {
        removeCommandFile(file);
        throw new Error(`Terminal could not open: ${stderr.trim()}`);
    }
    return { opened: true };
}
