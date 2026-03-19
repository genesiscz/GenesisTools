#!/usr/bin/env bun
import { resolve } from "node:path";

const SUBCOMMANDS = new Set([
    "tail",
    "history",
    "resume",
    "desktop",
    "usage",
    "config",
    "daemon",
    "migrate",
]);

const claude = resolve(import.meta.dir, "../claude/index.ts");
const args = process.argv.slice(2);
const firstArg = args[0]?.toLowerCase();

const cmd = SUBCOMMANDS.has(firstArg ?? "")
    ? ["bun", "run", claude, ...args]
    : ["bun", "run", claude, "resume", ...args];

const proc = Bun.spawn({
    cmd,
    stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
