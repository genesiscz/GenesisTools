import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

test("tools task run survives parent-shell exit (B8)", async () => {
    const S = `detach-${Date.now()}`;
    spawnSync(
        "bash",
        [
            "-c",
            `
        ${TASK_TOOL} task run --session ${S} --no-tty -- bash -c 'for i in $(seq 1 5); do echo tick $i; sleep 0.4; done' </dev/null >/dev/null 2>&1 &
        disown
    `,
        ],
        { encoding: "utf-8" }
    );

    await new Promise((r) => setTimeout(r, 4000));

    const get = spawnSync("bun", [TASK_TOOL, "task", "get", "--session", S], { encoding: "utf-8" });
    const combined = get.stdout + get.stderr;
    expect(combined).toMatch(/Lines:\s+5/);
    expect(combined).toMatch(/exited \(code 0/);

    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", S]);
}, 30_000);
