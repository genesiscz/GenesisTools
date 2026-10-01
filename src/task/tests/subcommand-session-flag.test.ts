import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

function help(subcommand: string): string {
    const r = spawnSync("bun", [TASK_TOOL, "task", subcommand, "--help"], { env: process.env, encoding: "utf-8" });
    return (r.stdout ?? "") + (r.stderr ?? "");
}

test.each(["get", "logs", "tail", "clean", "wait", "stop"])(
    "--session listed in 'tools task %s --help' (B4)",
    (sub) => {
        expect(help(sub)).toContain("--session");
    }
);

test("'tools task stop --help' lists --all, --port and --timeout", () => {
    const text = help("stop");

    expect(text).toContain("--all");
    expect(text).toContain("--port");
    expect(text).toContain("--timeout");
    expect(text).toContain("--yes");
});
