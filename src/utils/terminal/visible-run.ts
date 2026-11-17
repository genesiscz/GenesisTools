import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { detectTerminalApp } from "@genesiscz/utils/terminal";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";

export function visibleCommandScript(argv: readonly string[]): string {
    const command = shellCommandLine(argv);
    return `#!/bin/sh\nprintf '%s\\n' ${shellCommandLine([command])}\n${command}\nresult=$?\nif [ "$result" -ne 0 ]; then\n  printf 'Command failed (%s). Press Return to close.\\n' "$result"\n  read -r answer\nelse\n  sleep 5\nfi\nexit "$result"\n`;
}

/** cmux gets its own workspace; otherwise Launch Services opens a .command file in the person's terminal. */
export async function runVisibly(options: { argv: readonly string[]; timeoutMs: number }): Promise<{ opened: true }> {
    refuseHostEffectInTest("visible terminal", "Inject a terminal runner in tests.");
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
            });
            return { opened: true };
        }
    }
    const dir = toolDataDir("genesis-tools", "terminal");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${crypto.randomUUID()}.command`);
    writeFileSync(file, visibleCommandScript(options.argv), { mode: 0o700 });
    const proc = Bun.spawn(["/usr/bin/open", file], {
        stdout: "ignore",
        stderr: "pipe",
        timeout: Math.min(options.timeoutMs, 15_000),
    });
    const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exit !== 0) {
        throw new Error(`Terminal could not open: ${stderr.trim()}`);
    }
    return { opened: true };
}
