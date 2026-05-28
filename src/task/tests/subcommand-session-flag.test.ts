import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

function help(subcommand: string): string {
    const r = spawnSync("bun", [TASK_TOOL, "task", subcommand, "--help"], { encoding: "utf-8" });
    return (r.stdout ?? "") + (r.stderr ?? "");
}

test.each(["get", "logs", "tail", "clean", "wait"])("--session listed in 'tools task %s --help' (B4)", (sub) => {
    expect(help(sub)).toContain("--session");
});
