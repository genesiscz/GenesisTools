import { resolve } from "node:path";
import { registerCommand } from "../dispatcher";
import { stripAnsi } from "../formatting";

const TOOLS_PATH = resolve(import.meta.dir, "../../../../tools");

registerCommand("run", async (cmd) => {
  if (!cmd.args.trim()) return { text: "Usage: /run <preset-name>" };

  const presetName = cmd.args.trim().split(/\s+/)[0];
  const proc = Bun.spawn(["bun", "run", TOOLS_PATH, "automate", "run", presetName], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 120_000,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const output = stripAnsi(stdout + (stderr ? `\n${stderr}` : "")).trim();

  if (exitCode === 0) {
    return { text: `Preset "${presetName}" completed.\n\n${output || "(no output)"}` };
  }
  return { text: `Preset "${presetName}" failed (exit ${exitCode}).\n\n${output || "(no output)"}` };
});
