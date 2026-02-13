// Alias for claude-resume — pass all args through
import { resolve } from "node:path";

const claudeResume = resolve(import.meta.dir, "../claude-resume/index.ts");
const proc = Bun.spawn({
	cmd: ["bun", "run", claudeResume, ...process.argv.slice(2)],
	stdio: ["inherit", "inherit", "inherit"],
});

const exitCode = await proc.exited;
process.exit(exitCode);
