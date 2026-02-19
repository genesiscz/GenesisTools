import { resolve } from "node:path";
import { registerCommand } from "../dispatcher";
import { stripAnsi } from "../formatting";

const TOOLS_PATH = resolve(import.meta.dir, "../../../../tools");

registerCommand("tools", async (cmd) => {
  if (!cmd.args.trim()) return { text: "Usage: /tools <command> [args]\nExample: /tools claude usage" };

  const args = cmd.args.trim().split(/\s+/);
  const proc = Bun.spawn(["bun", "run", TOOLS_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30_000,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const output = stripAnsi(stdout + (stderr ? `\n${stderr}` : "")).trim();

  return { text: output || "(no output)" };
});
