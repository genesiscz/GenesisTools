#!/usr/bin/env bun
import { resolve } from "node:path";
import { out } from "@genesiscz/utils/logger";

const SUBCOMMANDS = new Set([
    "tail",
    "history",
    "resume",
    "desktop",
    "usage",
    "code",
    "info",
    "config",
    "daemon",
    "migrate",
    "login",
    "login-long",
    "login-secondary",
    "logout",
    "start",
    "run",
    "exec",
    "doctor",
]);

/**
 * `cc opus` / `cc fable` pick the account from usage data. Routed to `start`,
 * which falls back to a real account of that name if one exists (smartAliasOf).
 */
const SMART_ALIASES = new Set(["opus", "fable"]);

const claude = resolve(import.meta.dir, "../claude/index.ts");
const args = process.argv.slice(2);
const firstArg = args[0]?.toLowerCase();

/**
 * `cc` has no commander program, so it never gets runTool's `--readme`. Serve
 * this tool's own README instead of forwarding the flag to `claude resume`,
 * which would reject it as an unknown option.
 */
if (firstArg === "--readme") {
    out.print(await Bun.file(resolve(import.meta.dir, "README.md")).text());
    // print() only queues the write, so exiting here can truncate a piped stdout.
    await out.flush();
    process.exit(0);
}

const cmd = SUBCOMMANDS.has(firstArg ?? "")
    ? ["bun", "run", claude, ...args]
    : SMART_ALIASES.has(firstArg ?? "")
      ? ["bun", "run", claude, "start", ...args]
      : ["bun", "run", claude, "resume", ...args];

const proc = Bun.spawn({
    cmd,
    stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
