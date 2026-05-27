import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setupTaskIntegrationHome, withTaskSession } from "./task-integration-env";

const env = setupTaskIntegrationHome();
const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

test("tools task run survives parent-shell exit (B8)", async () => {
    const S = `detach-${Date.now()}`;

    await withTaskSession(env, S, async () => {
        spawnSync(
            "bash",
            [
                "-c",
                `
        export GENESIS_TOOLS_HOME="${env.homeDir}"
        ${TASK_TOOL} task run --session ${S} --no-tty -- bash -c 'for i in $(seq 1 5); do echo tick $i; sleep 0.4; done' </dev/null >/dev/null 2>&1 &
        disown
    `,
            ],
            { encoding: "utf-8", env: { ...process.env, GENESIS_TOOLS_HOME: env.homeDir } }
        );

        await new Promise((r) => setTimeout(r, 4000));

        const get = env.task(["get", "--session", S]);
        const combined = get.stdout + get.stderr;
        expect(combined).toMatch(/Lines:\s+5/);
        expect(combined).toMatch(/exited \(code 0/);
    });
}, 30_000);
