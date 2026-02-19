#!/usr/bin/env bun
// DEPRECATED: Use `tools claude resume` instead
import { resolve } from "node:path";
const claude = resolve(import.meta.dir, "../claude/index.ts");
const proc = Bun.spawn({
	cmd: ["bun", "run", claude, "resume", ...process.argv.slice(2)],
	stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
