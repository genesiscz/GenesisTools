import { existsSync } from "node:fs";
import { logger, out } from "@genesiscz/utils/logger";
import { installedGenesisAppLauncher, wrapWithGenesisApp } from "@genesiscz/utils/macos/genesis-app";
import type { Command } from "commander";

/**
 * Run osascript as GenesisTools.app rather than as the terminal.
 *
 * Automation grants ("send Apple events to System Events") are attached to the bundle that asks,
 * and `tools macos permissions` shows GenesisTools.app holding seven of them. A bare `osascript`
 * from a shell asks as the TERMINAL, which usually holds none, and fails with
 * `Not authorized to send Apple events to System Events. (-1743)`. Prepending the launcher makes
 * the script a direct child of the signed bundle, so it inherits the grants the bundle already has.
 *
 * ⚠️ Deliberately `installedGenesisAppLauncher()`, not `genesisAppLauncher()`. The latter returns
 * null when the CALLING process already runs under the app, on the assumption that responsibility
 * is inherited. That assumption holds for file and Calendar grants; it does not hold reliably for
 * Automation and Accessibility down a long descendant chain, which is exactly the case this command
 * exists to rescue. Always re-entering through the launcher costs one tiny process and removes the
 * failure mode entirely.
 */
export function registerOsascriptCommand(program: Command): void {
    program
        .command("osascript")
        .description("Run AppleScript/JXA as GenesisTools.app, so it uses the app's Automation grants")
        .argument("[script]", 'Script text, or "-" to read stdin')
        .option("-l, --language <name>", "Scripting language: AppleScript (default) or JavaScript")
        .option("-f, --file <path>", "Read the script from a file instead")
        .option("-e, --expr <line>", "One line of script; repeatable, like osascript -e", collectExpr, [])
        .option("--timeout <seconds>", "Give up after this long", "60")
        .option("--json", "Wrap the result as JSON instead of printing it raw")
        .action(async (script: string | undefined, options: OsascriptOptions) => {
            const args: string[] = [];

            if (options.language) {
                args.push("-l", options.language);
            }

            if (options.file) {
                if (!existsSync(options.file)) {
                    out.error(`No such script file: ${options.file}`);
                    process.exitCode = 1;
                    return;
                }

                args.push(options.file);
            } else if (options.expr.length > 0) {
                for (const line of options.expr) {
                    args.push("-e", line);
                }
            } else {
                const source = script === "-" || script === undefined ? await Bun.stdin.text() : script;

                if (!source.trim()) {
                    out.error("Nothing to run: pass a script, --file, -e, or pipe it on stdin");
                    process.exitCode = 1;
                    return;
                }

                args.push("-e", source);
            }

            const command = wrapWithGenesisApp(["/usr/bin/osascript", ...args]);

            if (!installedGenesisAppLauncher()) {
                // Honest degradation: still run it, but say plainly that the grants in play are the
                // terminal's, because that is the difference between a -1743 and a result.
                logger.warn(
                    "GenesisTools.app is unavailable or switched off; running osascript as this terminal instead"
                );
            }

            logger.debug({ viaApp: command[0] !== "/usr/bin/osascript", argc: args.length }, "running osascript");

            const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
            const timer = setTimeout(() => proc.kill(), Number(options.timeout) * 1000);

            try {
                const [stdout, stderr] = await Promise.all([
                    new Response(proc.stdout).text(),
                    new Response(proc.stderr).text(),
                ]);
                const exitCode = await proc.exited;

                if (options.json) {
                    out.result({ ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
                } else {
                    if (stdout.trim()) {
                        out.println(stdout.trimEnd());
                    }

                    if (stderr.trim()) {
                        out.error(stderr.trimEnd());
                    }
                }

                if (exitCode !== 0) {
                    process.exitCode = exitCode === null ? 1 : exitCode;
                }
            } finally {
                clearTimeout(timer);
            }
        });
}

interface OsascriptOptions {
    language?: string;
    file?: string;
    expr: string[];
    timeout: string;
    json?: boolean;
}

function collectExpr(value: string, previous: string[]): string[] {
    return [...previous, value];
}
