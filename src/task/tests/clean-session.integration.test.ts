import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SafeJSON } from "@app/utils/json";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("bun", [TASK_TOOL, "task", ...args], { encoding: "utf-8" });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("clean --session removes ONE session, leaves others (B5)", () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const A = `clean-a-${suffix}`;
    const B = `clean-b-${suffix}`;

    run(["run", "--session", A, "--no-tty", "--", "bash", "-c", "echo a"]);
    run(["run", "--session", B, "--no-tty", "--", "bash", "-c", "echo b"]);

    const cleanResult = run(["clean", "--session", A]);
    expect(cleanResult.code).toBe(0);

    const list = run(["sessions", "--json"]);
    const names = (SafeJSON.parse(list.stdout) as Array<{ name: string }>).map((s) => s.name);
    expect(names).not.toContain(A);
    expect(names).toContain(B);

    run(["clean", "--session", B]);
});
